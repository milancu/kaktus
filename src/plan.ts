// Plánovací část zápisu – čisté funkce bez I/O.
// Pořadí kroků pro každý doklad: identita → autorizace klient→firma → plná validace →
// příprava hodnot (sanitace, ořezy) → deduplikace → zařazení k zápisu.
// Samotné spuštění importu, dávky po 20 a ověření výsledku řeší navazující kód (write.ts).

import type { BatchDoklad } from "./kaktus/batch";
import { dokladKey, buildDedupIndex, lookupMarker, lookupNumber } from "./kaktus/dedup";
import type { DedupIndex } from "./kaktus/dedup";
import { FIRMA_ID_RE } from "./kaktus/read";
import type { Firma, FirmaData } from "./kaktus/read";
import { prepareDoklad } from "./kaktus/prepare";
import { parseDoklad, parseIdentita } from "./taxy/input";
import type { Klient } from "./taxy/input";

export type PlanStav = "k_zapisu" | "jiz_zapsano" | "odmitnuto";

/** Výsledek plánování pro jeden doklad ze vstupu (v pořadí vstupního souboru). */
export interface PlanVysledek {
  /** Pořadí dokladu ve vstupním souboru (od 0). */
  index: number;
  /** ID dokladu z TAXY; null, pokud chybí nebo je neplatné. */
  id: string | null;
  klientId: number | null;
  /** ID firmy v Kaktusu – vyplněno jen po úspěšné autorizaci. */
  firma: string | null;
  stav: PlanStav;
  /** Český důvod odmítnutí (stav `odmitnuto`). */
  duvod?: string;
  /** Číslo dokladu v Kaktusu (FPrrnnnn), je-li doklad už zapsaný (stav `jiz_zapsano`). */
  kaktusDoklad?: string;
  varovani: string[];
}

/** Doklad zařazený k zápisu. Tvar `{ doklad }` používá `buildBatches`. */
export interface PlanovanyDoklad {
  index: number;
  id: string;
  klientId: number;
  doklad: BatchDoklad;
  varovani: string[];
}

export interface PlanFirma {
  firma: Firma;
  kZapisu: PlanovanyDoklad[];
}

export interface WritePlan {
  /** Doklady k zápisu podle firmy (jen firmy, pro které je co zapisovat). */
  perFirma: Map<string, PlanFirma>;
  /** Jeden záznam pro každý doklad ze vstupu, v pořadí vstupu. */
  vysledky: PlanVysledek[];
}

export type AutorizaceVysledek =
  | { ok: true; klient: Klient; firma: Firma }
  | { ok: false; duvod: string };

/**
 * Autorizace klient → firma (ochrana proti IDOR). Doklad smí do firmy jen tehdy, když:
 *  - `klientId` je v seznamu klientů právě jednou,
 *  - jeho `kaktusFirma` má platný tvar a existuje (nesmazaná) ve FIRMY.DBF,
 *  - IČO odběratele z dokladu == IČO klienta == IČO firmy ve FIRMY.DBF.
 * Firmu určuje výhradně tato funkce z konfigurace klientů; z obsahu dokladu se nikdy nebere.
 * Při jakémkoli nesouladu se odmítá, nic se nehádá.
 */
export function authorizeKlient(
  klientId: number,
  odberatelIco: string,
  klienti: readonly Klient[],
  firmyData: ReadonlyMap<string, FirmaData>,
): AutorizaceVysledek {
  const shody = klienti.filter((k) => k.klientId === klientId);
  if (shody.length === 0) return { ok: false, duvod: `Klient ${klientId} není v seznamu klientů.` };
  const klient = shody[0] as Klient;
  if (shody.length > 1) return { ok: false, duvod: `Klient ${klientId} je v seznamu klientů vícekrát.` };
  if (!FIRMA_ID_RE.test(klient.kaktusFirma)) {
    return { ok: false, duvod: `Klient ${klientId} má neplatné přiřazení k firmě v Kaktusu.` };
  }
  const data = firmyData.get(klient.kaktusFirma);
  if (data === undefined || data.firma.id !== klient.kaktusFirma || data.firma.smazano) {
    return { ok: false, duvod: `Firma ${klient.kaktusFirma} klienta ${klientId} v Kaktusu neexistuje.` };
  }
  if (data.firma.ico === null) {
    return { ok: false, duvod: `Firma ${klient.kaktusFirma} nemá v Kaktusu vyplněné IČO.` };
  }
  if (klient.ico !== data.firma.ico) {
    return { ok: false, duvod: `IČO klienta ${klientId} se neshoduje s IČO firmy ${klient.kaktusFirma} v Kaktusu.` };
  }
  if (odberatelIco !== klient.ico) {
    return { ok: false, duvod: `IČO odběratele na dokladu se neshoduje s IČO klienta ${klientId}; doklad nepatří této firmě.` };
  }
  return { ok: true, klient, firma: data.firma };
}

/**
 * Naplánuje zápis. `rawDoklady` jsou doklady přímo z JSONu (každý se validuje zvlášť),
 * `firmyData` jsou aktuální data firem z Kaktusu (klíč = ID firmy) – FIRMY, ADRESAR, FAKPRI.
 * Firma, která v mapě chybí, se považuje za neexistující.
 */
export function planWrite(
  klienti: readonly Klient[],
  rawDoklady: readonly unknown[],
  firmyData: ReadonlyMap<string, FirmaData>,
): WritePlan {
  const vysledky: PlanVysledek[] = [];
  const perFirma = new Map<string, PlanFirma>();
  const indexy = new Map<string, DedupIndex>();
  const videnaId = new Set<string>();
  /** firma + klíč dokladu → ID prvního dokladu s tímto klíčem (duplicita ve vstupu). */
  const videneKlice = new Map<string, string>();

  const indexFor = (firma: string, data: FirmaData): DedupIndex => {
    let idx = indexy.get(firma);
    if (!idx) {
      idx = buildDedupIndex(data);
      indexy.set(firma, idx);
    }
    return idx;
  };

  rawDoklady.forEach((raw, index) => {
    const odmitnout = (
      id: string | null, klientId: number | null, firma: string | null, duvod: string, varovani: string[] = [],
    ): void => {
      vysledky.push({ index, id, klientId, firma, stav: "odmitnuto", duvod, varovani });
    };

    // 1. Identita (id, klientId, IČO odběratele) – nutná k autorizaci.
    const ident = parseIdentita(raw);
    if (!ident.ok) {
      odmitnout(ident.id, ident.klientId, null, ident.duvody.join(" "));
      return;
    }
    const { id, klientId, odberatelIco } = ident.identita;
    if (videnaId.has(id)) {
      odmitnout(id, klientId, null, "Duplicitní „id“ dokladu ve vstupu.");
      return;
    }
    videnaId.add(id);

    // 2. Autorizace – bez ní se doklad dál nezpracovává.
    const auth = authorizeKlient(klientId, odberatelIco, klienti, firmyData);
    if (!auth.ok) {
      odmitnout(id, klientId, null, auth.duvod);
      return;
    }
    const firmaId = auth.firma.id;

    // 3. Plná validace.
    const parsed = parseDoklad(raw);
    if (!parsed.ok) {
      odmitnout(id, klientId, firmaId, parsed.duvody.join(" "));
      return;
    }

    // 4. Příprava hodnot polí (sanitace, ořezy, varování).
    const prep = prepareDoklad(parsed.doklad);
    if (!prep.ok) {
      odmitnout(id, klientId, firmaId, prep.duvod);
      return;
    }
    const varovani = prep.varovani;
    const bd = prep.doklad;

    // 5. Deduplikace.
    const data = firmyData.get(firmaId) as FirmaData; // existence ověřila autorizace
    const idx = indexFor(firmaId, data);
    const key = dokladKey(bd.dodavatel.ico, bd.dodavatel.nazev, bd.cisloDodavatele);
    const vstupKey = `${firmaId}\u0000${key}`;

    const markerHits = lookupMarker(idx, id);
    const hotovo = markerHits.zive[0];
    if (hotovo !== undefined) {
      if (!videneKlice.has(vstupKey)) videneKlice.set(vstupKey, id);
      vysledky.push({
        index, id, klientId, firma: firmaId, stav: "jiz_zapsano", kaktusDoklad: hotovo.doklad, varovani,
      });
      return;
    }

    const predchozi = videneKlice.get(vstupKey);
    if (predchozi !== undefined) {
      odmitnout(id, klientId, firmaId, `Duplicita ve vstupu: stejný dodavatel a číslo dokladu jako doklad ${predchozi}.`, varovani);
      return;
    }
    videneKlice.set(vstupKey, id);

    const cisloHits = lookupNumber(idx, key);
    const rucne = cisloHits.zive[0];
    if (rucne !== undefined) {
      vysledky.push({
        index, id, klientId, firma: firmaId, stav: "jiz_zapsano", kaktusDoklad: rucne.doklad,
        varovani: [
          ...varovani,
          `Doklad už v Kaktusu je (${rucne.doklad}, shoda podle čísla dokladu dodavatele a dodavatele, ne podle značky TAXY).`,
        ],
      });
      return;
    }

    const smazane = [...markerHits.smazane, ...cisloHits.smazane];
    if (smazane.length > 0) {
      const cisla = [...new Set(smazane.map((f) => f.doklad))].join(", ");
      varovani.push(`V Kaktusu existuje smazaný doklad se stejným číslem dodavatele (${cisla}); doklad se přesto zapíše.`);
    }

    // 6. K zápisu.
    let pf = perFirma.get(firmaId);
    if (!pf) {
      pf = { firma: auth.firma, kZapisu: [] };
      perFirma.set(firmaId, pf);
    }
    pf.kZapisu.push({ index, id, klientId, doklad: bd, varovani });
    vysledky.push({ index, id, klientId, firma: firmaId, stav: "k_zapisu", varovani });
  });

  return { perFirma, vysledky };
}

