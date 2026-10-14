// Orchestrace zápisu: načtení dat firem → plán (autorizace, validace, deduplikace) →
// pro každou firmu po dávkách: čerstvé načtení FAKPRI + přeplánování → import → ověření podle DBF.
//
// Pravda je vždy DBF: po každé dávce (i po pádu nebo chybějící odpovědi) se FAKPRI načte znovu
// a výsledek každého dokladu se určí podle značky `TAXY:<id>`. Odpověď Kaktusu je jen nápověda
// (kód a text chyby, kontrola rozporů).

import * as fs from "node:fs";
import * as path from "node:path";
import { VstupniChyba } from "./errors";
import { buildBatches, MAX_BATCH_SIZE } from "./kaktus/batch";
import { buildDedupIndex, lookupMarker } from "./kaktus/dedup";
import { importDavka, resolveKaktusScript } from "./kaktus/import";
import type { ImportRunner, ImportVysledek } from "./kaktus/import";
import { FIRMA_ID_RE, readFirmaData, readFirmy, resolveFirmaDir } from "./kaktus/read";
import type { FirmaData } from "./kaktus/read";
import { planWrite } from "./plan";
import type { PlanovanyDoklad } from "./plan";
import type { Klient } from "./taxy/input";

export type StavDokladu = "zapsano" | "jiz_zapsano" | "odmitnuto" | "chyba_kaktusu" | "neprovedeno" | "k_zapisu";

export const STAVY: readonly StavDokladu[] = [
  "zapsano", "jiz_zapsano", "odmitnuto", "chyba_kaktusu", "neprovedeno", "k_zapisu",
];

/** Řádek reportu pro jeden doklad ze vstupu. */
export interface ZapisDoklad {
  id: string | null;
  klientId: number | null;
  firma: string | null;
  stav: StavDokladu;
  /** Číslo dokladu v Kaktusu (FPrrnnnn) – `zapsano`, `jiz_zapsano`. */
  kaktusDoklad?: string;
  /** Kód chyby Kaktusu (`chyba_kaktusu`). */
  kod?: string;
  duvod?: string;
  varovani: string[];
}

export type Pocty = Record<StavDokladu, number>;

export interface FirmaSouhrn {
  pocty: Pocty;
  /** Proč se zpracování firmy přerušilo (zámek, pád importu…); chybí, pokud proběhlo celé. */
  preruseno?: string;
}

export interface ZapisReport {
  format: 1;
  rezim: "zapis" | "dry-run";
  souhrn: {
    celkem: number;
    pocty: Pocty;
    firmy: Record<string, FirmaSouhrn>;
  };
  doklady: ZapisDoklad[];
}

export interface ZapisOpts {
  kaktusDir: string;
  klienti: readonly Klient[];
  /** Surové doklady z JSONu (každý se validuje zvlášť). */
  doklady: readonly unknown[];
  dryRun?: boolean;
  /** Náhrada spouštěče importu (testy: simulace pádu). */
  runner?: ImportRunner;
  timeoutMs?: number;
  /** Kořen dočasných adresářů (výchozí `os.tmpdir()`). */
  tmpRoot?: string;
  /** Velikost dávky 1–20 (výchozí 20; menší hodnota jen pro testy). */
  maxDavka?: number;
}

export function prazdnePocty(): Pocty {
  return { zapsano: 0, jiz_zapsano: 0, odmitnuto: 0, chyba_kaktusu: 0, neprovedeno: 0, k_zapisu: 0 };
}

/** Souhrn podle stavů, celkem i po firmách (doklady bez firmy jsou jen v celkovém součtu). */
export function sestavSouhrn(
  doklady: readonly ZapisDoklad[], prerusene: ReadonlyMap<string, string>,
): ZapisReport["souhrn"] {
  const pocty = prazdnePocty();
  const byFirma = new Map<string, FirmaSouhrn>();
  for (const d of doklady) {
    pocty[d.stav]++;
    if (d.firma !== null) {
      let f = byFirma.get(d.firma);
      if (!f) {
        f = { pocty: prazdnePocty() };
        byFirma.set(d.firma, f);
      }
      f.pocty[d.stav]++;
    }
  }
  const firmy: Record<string, FirmaSouhrn> = {};
  for (const k of [...byFirma.keys()].sort()) {
    const f = byFirma.get(k) as FirmaSouhrn;
    const duvod = prerusene.get(k);
    firmy[k] = duvod === undefined ? f : { pocty: f.pocty, preruseno: duvod };
  }
  return { celkem: doklady.length, pocty, firmy };
}

// ---------------------------------------------------------------------------
// Ověření dávky podle DBF (čistá funkce)
// ---------------------------------------------------------------------------

export interface PolozkaVysledek {
  stav: "zapsano" | "chyba_kaktusu" | "neprovedeno";
  kaktusDoklad?: string;
  kod?: string;
  duvod?: string;
  varovani: string[];
}

/** Důvod, proč se import nezdařil; null = import doběhl (exit 0). */
function duvodSelhani(firma: string, imp: ImportVysledek | null): string | null {
  if (imp === null) return `Firmu ${firma} se nepodařilo ověřit; import nebyl spuštěn.`;
  switch (imp.stav) {
    case "zpracovano": return null;
    case "firma_zamcena": return `Firma ${firma} je v Kaktusu otevřená (zámek FIRMA.LCK); doklad nebyl zapsán, zkuste znovu po jejím zavření.`;
    case "firma_neexistuje": return `Kaktus hlásí, že firma ${firma} neexistuje; doklad nebyl zapsán.`;
    case "davka_necitelna": return "Kaktus dávku nepřečetl (nic nezapsal); doklad nebyl zapsán.";
    case "pad": return `Import se nedokončil (${imp.detail ?? "pád"}); doklad nebyl zapsán, zkuste znovu.`;
  }
}

/**
 * Určí výsledek každé položky dávky podle čerstvě načtených dat (`fresh`) a výsledku importu.
 * `polozky[i]` odpovídá v odpovědi `poradi = i + 1`. Pravdu má DBF; rozpor s odpovědí je varování.
 *  - značka `TAXY:<id>` v nesmazaném dokladu → `zapsano` (s číslem dokladu z DBF);
 *  - jinak odpověď s kódem chyby → `chyba_kaktusu`;
 *  - jinak (zámek, pád, chybějící odpověď, rozpor) → `neprovedeno`.
 */
export function reconcileDavka(
  firma: string,
  polozky: readonly { id: string }[],
  fresh: Pick<FirmaData, "dodavatele" | "faktury">,
  imp: ImportVysledek | null,
): PolozkaVysledek[] {
  const idx = buildDedupIndex(fresh);
  const selhani = duvodSelhani(firma, imp);
  return polozky.map((p, i): PolozkaVysledek => {
    const varovani: string[] = [];
    const resp = imp?.odpoved?.doklady.get(i + 1);
    const zive = lookupMarker(idx, p.id).zive;
    const nalez = zive[0];
    if (nalez !== undefined) {
      if (zive.length > 1) {
        varovani.push(`Značka dokladu je v Kaktusu u více dokladů (${zive.map((f) => f.doklad).join(", ")}); zkontrolujte duplicitu.`);
      }
      if (resp?.stav === "CHYBA") {
        varovani.push(`Odpověď Kaktusu hlásí chybu ${resp.kod ?? ""}, ale doklad je v databázi; platí databáze.`);
      } else if (resp?.stav === "OK" && resp.doklad !== nalez.doklad) {
        varovani.push(`Odpověď Kaktusu uvádí doklad ${resp.doklad ?? ""}, v databázi je ${nalez.doklad}; platí databáze.`);
      }
      return { stav: "zapsano", kaktusDoklad: nalez.doklad, varovani };
    }
    if (resp?.stav === "CHYBA") {
      return { stav: "chyba_kaktusu", kod: resp.kod, duvod: resp.zprava ?? "", varovani };
    }
    if (resp?.stav === "OK") {
      varovani.push(`Odpověď Kaktusu hlásí zápis (${resp.doklad ?? ""}), ale doklad v databázi není; platí databáze.`);
      return { stav: "neprovedeno", duvod: "Zápis se nepodařilo ověřit v databázi Kaktusu; zkuste znovu.", varovani };
    }
    let duvod = selhani ?? "Odpověď Kaktusu neobsahuje výsledek dokladu a doklad v databázi není; zkuste znovu.";
    if (selhani === null && imp?.odpovedChyba !== undefined) duvod = "Odpověď Kaktusu nelze použít a doklad v databázi není; zkuste znovu.";
    return { stav: "neprovedeno", duvod, varovani };
  });
}

// ---------------------------------------------------------------------------
// Orchestrace
// ---------------------------------------------------------------------------

function isLocked(firmaDir: string): boolean {
  return fs.existsSync(path.join(firmaDir, "FIRMA.LCK"));
}

/**
 * Načte data firem, na které se odkazují klienti. Neexistující nebo smazaná firma se do mapy
 * nedostane (autorizace pak doklady odmítne). Nečitelná data existující firmy = `VstupniChyba`
 * (nic se nezapíše; nečitelnou firmu nelze zaměnit za „neexistující“).
 */
export function loadFirmyData(kaktusDir: string, klienti: readonly Klient[]): Map<string, FirmaData> {
  const existujici = new Set(readFirmy(kaktusDir).filter((f) => !f.smazano).map((f) => f.id));
  const out = new Map<string, FirmaData>();
  for (const k of klienti) {
    const id = k.kaktusFirma;
    if (!FIRMA_ID_RE.test(id) || !existujici.has(id) || out.has(id)) continue;
    try {
      out.set(id, readFirmaData(kaktusDir, id));
    } catch (e) {
      if (e instanceof VstupniChyba) throw new VstupniChyba(`Data firmy ${id} nelze načíst: ${e.message}`);
      throw e;
    }
  }
  return out;
}

/** Řádek reportu s pevným pořadím klíčů (deterministický výstup). */
function uporadej(r: ZapisDoklad): ZapisDoklad {
  const out: Record<string, unknown> = { id: r.id, klientId: r.klientId, firma: r.firma, stav: r.stav };
  if (r.kaktusDoklad !== undefined) out.kaktusDoklad = r.kaktusDoklad;
  if (r.kod !== undefined) out.kod = r.kod;
  if (r.duvod !== undefined) out.duvod = r.duvod;
  out.varovani = r.varovani;
  return out as unknown as ZapisDoklad;
}

interface Kontext {
  opts: ZapisOpts;
  report: ZapisDoklad[];
  prerusene: Map<string, string>;
}

function nastav(
  radek: ZapisDoklad, v: { stav: StavDokladu; kaktusDoklad?: string; kod?: string; duvod?: string; varovani?: string[] },
): void {
  radek.stav = v.stav;
  delete radek.kaktusDoklad;
  delete radek.kod;
  delete radek.duvod;
  if (v.kaktusDoklad !== undefined) radek.kaktusDoklad = v.kaktusDoklad;
  if (v.kod !== undefined) radek.kod = v.kod;
  if (v.duvod !== undefined) radek.duvod = v.duvod;
  if (v.varovani !== undefined) radek.varovani = [...v.varovani];
}

function neprovedeno(ctx: Kontext, polozky: readonly { index: number }[], duvod: string): void {
  for (const p of polozky) nastav(ctx.report[p.index] as ZapisDoklad, { stav: "neprovedeno", duvod });
}

async function zpracujFirmu(ctx: Kontext, firmaId: string, kZapisu: readonly PlanovanyDoklad[]): Promise<void> {
  const { opts } = ctx;
  const velikost = opts.maxDavka ?? MAX_BATCH_SIZE;
  let zbyva = [...kZapisu];

  const prerus = (duvod: string, polozky: readonly { index: number }[]): void => {
    ctx.prerusene.set(firmaId, duvod);
    neprovedeno(ctx, polozky, duvod);
  };

  while (zbyva.length > 0) {
    const slice = zbyva.slice(0, velikost);
    zbyva = zbyva.slice(velikost);

    // 1. Čerstvá data firmy a přeplánování dávky (idempotence i mezi dávkami).
    let fresh: FirmaData;
    let firmaDir: string;
    try {
      fresh = readFirmaData(opts.kaktusDir, firmaId);
      firmaDir = resolveFirmaDir(opts.kaktusDir, fresh.firma);
    } catch (e) {
      const d = `Data firmy ${firmaId} nelze načíst${e instanceof Error ? `: ${e.message}` : "."}`;
      prerus(d, [...slice, ...zbyva]);
      return;
    }
    const replan = planWrite(opts.klienti, slice.map((p) => opts.doklady[p.index]), new Map([[firmaId, fresh]]));
    for (const v of replan.vysledky) {
      if (v.stav === "k_zapisu") continue;
      const radek = ctx.report[(slice[v.index] as PlanovanyDoklad).index] as ZapisDoklad;
      nastav(radek, { stav: v.stav, kaktusDoklad: v.kaktusDoklad, duvod: v.duvod, varovani: v.varovani });
    }
    const items: PlanovanyDoklad[] = (replan.perFirma.get(firmaId)?.kZapisu ?? []).map((p) => {
      const puvodni = slice[p.index] as PlanovanyDoklad;
      (ctx.report[puvodni.index] as ZapisDoklad).varovani = [...p.varovani];
      return { ...p, index: puvodni.index };
    });
    if (items.length === 0) continue;

    // 2. Předběžná kontrola zámku (Kaktus ji dělá jen na začátku importu, viz i exit 3).
    if (isLocked(firmaDir)) {
      prerus(`Firma ${firmaId} je v Kaktusu otevřená (zámek FIRMA.LCK); doklady nebyly zapsány, zkuste znovu po jejím zavření.`, [...items, ...zbyva]);
      return;
    }

    // 3. Dávka → import → ověření podle DBF.
    const davka = buildBatches(firmaId, items, MAX_BATCH_SIZE)[0];
    if (davka === undefined) continue;
    const imp = await importDavka(opts.kaktusDir, davka.xml, {
      firma: firmaId, pocet: davka.polozky.length, timeoutMs: opts.timeoutMs, runner: opts.runner, tmpRoot: opts.tmpRoot,
    });
    let po: FirmaData;
    try {
      po = readFirmaData(opts.kaktusDir, firmaId);
    } catch {
      prerus(`Po importu se nepodařilo načíst data firmy ${firmaId}; výsledek nelze ověřit, zkuste znovu (zápis je idempotentní).`, [...davka.polozky, ...zbyva]);
      return;
    }
    const vysledky = reconcileDavka(firmaId, davka.polozky, po, imp);
    let nejasne = false;
    vysledky.forEach((v, i) => {
      const radek = ctx.report[(davka.polozky[i] as PlanovanyDoklad).index] as ZapisDoklad;
      nastav(radek, { ...v, varovani: [...radek.varovani, ...v.varovani] });
      if (v.stav === "neprovedeno") nejasne = true;
    });
    if (imp.stav !== "zpracovano" || nejasne) {
      // Zámek, pád nebo neověřený doklad: další dávky téže firmy nezkoušíme (bezpečné spustit znovu).
      const d = duvodSelhani(firmaId, imp) ?? `Výsledek některých dokladů firmy ${firmaId} se nepodařilo ověřit.`;
      prerus(d, zbyva);
      return;
    }
  }
}

/**
 * Provede zápis (nebo jeho plán při `dryRun`). Nikdy nehází kvůli pádu importu ani kvůli
 * nečekané chybě uvnitř jedné firmy (její zbylé doklady jsou `neprovedeno`); `VstupniChyba`
 * vyhazuje jen před jakýmkoli zápisem (nečitelná data, chybějící kaktus.cjs).
 */
export async function zapis(opts: ZapisOpts): Promise<ZapisReport> {
  const dryRun = opts.dryRun === true;
  if (!dryRun) resolveKaktusScript(opts.kaktusDir);
  const firmyData = loadFirmyData(opts.kaktusDir, opts.klienti);
  const plan = planWrite(opts.klienti, opts.doklady, firmyData);

  const report: ZapisDoklad[] = plan.vysledky.map((v) => {
    const r: ZapisDoklad = { id: v.id, klientId: v.klientId, firma: v.firma, stav: v.stav, varovani: [...v.varovani] };
    if (v.kaktusDoklad !== undefined) r.kaktusDoklad = v.kaktusDoklad;
    if (v.duvod !== undefined) r.duvod = v.duvod;
    return r;
  });
  const prerusene = new Map<string, string>();

  if (!dryRun) {
    const ctx: Kontext = { opts, report, prerusene };
    for (const [firmaId, pf] of plan.perFirma) {
      try {
        await zpracujFirmu(ctx, firmaId, pf.kZapisu);
      } catch (e) {
        prerusene.set(firmaId, `Nečekaná chyba při zpracování firmy ${firmaId}${e instanceof Error ? `: ${e.message}` : "."}`);
      }
    }
    // Pojistka: doklad, který zůstal ve stavu „k zápisu“, nebyl zpracován.
    for (const r of report) {
      if (r.stav === "k_zapisu") {
        const d = r.firma === null ? undefined : prerusene.get(r.firma);
        nastav(r, { stav: "neprovedeno", duvod: d ?? "Doklad nebyl zpracován; zkuste znovu." });
      }
    }
  }
  const doklady = report.map(uporadej);
  return { format: 1, rezim: dryRun ? "dry-run" : "zapis", souhrn: sestavSouhrn(doklady, prerusene), doklady };
}
