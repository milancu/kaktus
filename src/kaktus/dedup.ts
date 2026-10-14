// Deduplikace proti stavu Kaktusu (čisté funkce nad načtenými daty, bez I/O).
// Kaktus duplicity nekontroluje, takže je hlídáme my:
//  1. primárně podle značky `TAXY:<id>` v poznámce dokladu;
//  2. záložně (ručně zadané doklady) podle čísla dokladu dodavatele a dodavatele.
//     Dodavatel se určuje takto (shoda je symetrická):
//      - oba mají IČO → musí se shodovat IČO (přes VŠECHNY partnery se stejným IČO);
//      - alespoň jeden IČO nemá → musí se shodovat název (normalizovaný, max. 40 znaků).
//     Kdyby IČO chybělo jen na jedné straně a hledalo se jen podle IČO, ručně zadaný doklad
//     by se nenašel a doklad by se zapsal podruhé. Variabilní symbol se nepoužívá (liší se).
// Smazaný doklad duplicitou není, ale hlásíme ho (varování, resp. u naší značky odmítnutí).

import type { Dodavatel, FakturaPrijata, FirmaData } from "./read";
import { FIELD_LIMITS, normalizeIco } from "./format";
import { TAXY_PREFIX } from "./prepare";

/**
 * Z poznámky vytáhne ID dokladů ze značek `TAXY:<id>`. Porovnává se celé ID (ne předpona),
 * takže `TAXY:doc_1` neodpovídá dokladu `doc_12`.
 */
export function extractTaxyIds(poznamka: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(`(?:^|[\\s;,|])${TAXY_PREFIX}([A-Za-z0-9_-]+)`, "g");
  for (let m = re.exec(poznamka); m !== null; m = re.exec(poznamka)) ids.push(m[1] as string);
  return ids;
}

/**
 * Normalizace názvu dodavatele pro porovnání: NFC, sloučené mezery, oříznutí na délku pole
 * partnera (40), bez rozlišení velikosti písmen.
 */
export function normalizeNazev(nazev: string): string {
  return nazev.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, FIELD_LIMITS.nazev).trim().toLowerCase();
}

/** Klíč podle IČO: `[ico, číslo]`. */
function icoKey(ico: string, cislo: string): string {
  return JSON.stringify(["ico", normalizeIco(ico), cislo.trim()]);
}

/** Klíč podle názvu: `[název, číslo]`. */
function nazevKey(nazev: string, cislo: string): string {
  return JSON.stringify(["nazev", normalizeNazev(nazev), cislo.trim()]);
}

/**
 * Klíč „stejný doklad od stejného dodavatele“. S IČO se dodavatel určuje IČO, bez IČO názvem.
 * `cislo` musí být ve stejné podobě jako v DBF (sanitované a ořezané na 20 znaků).
 */
export function dokladKey(ico: string | null, nazev: string, cislo: string): string {
  return ico !== null ? icoKey(ico, cislo) : nazevKey(nazev, cislo);
}

/**
 * Rejstřík dokladů podle dodavatele a čísla. Každá položka je uložena pod klíčem podle IČO
 * (má-li je) a pod klíčem podle názvu; hledání pak dodržuje pravidlo „oba IČO → IČO, jinak název“.
 */
export class DodavatelDokladRejstrik<T> {
  /** `dokladKey` partnera: s IČO podle IČO, bez IČO podle názvu. */
  private readonly podleKlice = new Map<string, T[]>();
  /** Všichni partneři podle názvu (i ti s IČO), pro hledání dokladu bez IČO. */
  private readonly podleNazvu = new Map<string, T[]>();

  private static push<V>(map: Map<string, V[]>, key: string, v: V): void {
    const list = map.get(key);
    if (list) list.push(v);
    else map.set(key, [v]);
  }

  add(ico: string | null, nazev: string, cislo: string, value: T): void {
    DodavatelDokladRejstrik.push(this.podleKlice, dokladKey(ico, nazev, cislo), value);
    DodavatelDokladRejstrik.push(this.podleNazvu, nazevKey(nazev, cislo), value);
  }

  /** Přesný klíč z `dokladKey` (jen podle IČO, resp. jen podle názvu u partnerů bez IČO). */
  byKey(key: string): T[] {
    return this.podleKlice.get(key) ?? [];
  }

  /**
   * Shody pro doklad s daným dodavatelem: s IČO podle IČO a navíc podle názvu mezi partnery
   * bez IČO; bez IČO podle názvu přes všechny partnery.
   */
  find(ico: string | null, nazev: string, cislo: string): T[] {
    if (ico === null) return this.podleNazvu.get(nazevKey(nazev, cislo)) ?? [];
    return [...this.byKey(icoKey(ico, cislo)), ...this.byKey(nazevKey(nazev, cislo))];
  }
}

interface Hits {
  zive: FakturaPrijata[];
  smazane: FakturaPrijata[];
}

export interface DedupIndex {
  markers: Map<string, Hits>;
  cisla: DodavatelDokladRejstrik<FakturaPrijata>;
}

function addHit(map: Map<string, Hits>, key: string, f: FakturaPrijata): void {
  let h = map.get(key);
  if (!h) {
    h = { zive: [], smazane: [] };
    map.set(key, h);
  }
  (f.smazano ? h.smazane : h.zive).push(f);
}

function toHits(list: readonly FakturaPrijata[]): Hits {
  return { zive: list.filter((f) => !f.smazano), smazane: list.filter((f) => f.smazano) };
}

/**
 * Sestaví index pro rychlé hledání. Dodavatele záznamu určuje `PARTNER`; partner s příznakem
 * smazání se pro určení IČO/názvu dokladu používá také (nesmazaný doklad je platný doklad,
 * i když někdo smazal jeho partnera) – viz docs/ROZHODNUTI.md.
 */
export function buildDedupIndex(data: Pick<FirmaData, "dodavatele" | "faktury">): DedupIndex {
  const partners = new Map<number, Dodavatel>();
  for (const p of data.dodavatele) partners.set(p.id, p);
  const markers = new Map<string, Hits>();
  const cisla = new DodavatelDokladRejstrik<FakturaPrijata>();
  for (const f of data.faktury) {
    for (const id of extractTaxyIds(f.poznamka)) addHit(markers, id, f);
    const partner = f.partnerId === null ? undefined : partners.get(f.partnerId);
    if (partner !== undefined) cisla.add(partner.ico, partner.nazev, f.cisloDodavatele, f);
  }
  return { markers, cisla };
}

const NONE: Hits = { zive: [], smazane: [] };

export function lookupMarker(index: DedupIndex, docId: string): Hits {
  return index.markers.get(docId) ?? NONE;
}

/** Přesné hledání podle klíče z `dokladKey` (bez křížení IČO/název; viz `lookupDoklad`). */
export function lookupNumber(index: DedupIndex, key: string): Hits {
  return toHits(index.cisla.byKey(key));
}

/** Záložní shoda pro doklad z TAXY: číslo dokladu dodavatele + dodavatel (IČO, resp. název). */
export function lookupDoklad(index: DedupIndex, ico: string | null, nazev: string, cislo: string): Hits {
  return toHits(index.cisla.find(ico, nazev, cislo));
}
