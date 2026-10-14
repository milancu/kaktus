// Deduplikace proti stavu Kaktusu (čisté funkce nad načtenými daty, bez I/O).
// Kaktus duplicity nekontroluje, takže je hlídáme my:
//  1. primárně podle značky `TAXY:<id>` v poznámce nesmazaného dokladu;
//  2. záložně (ručně zadané doklady) podle čísla dokladu dodavatele a dodavatele –
//     přes VŠECHNY partnery se stejným IČO (v adresáři mohou být duplicitní); dodavatel
//     bez IČO se porovnává podle názvu. Variabilní symbol se nepoužívá (liší se).
// Smazaný doklad duplicitou není, ale hlásíme ho jako varování.

import type { Dodavatel, FakturaPrijata, FirmaData } from "./read";
import { normalizeIco } from "./format";
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
 * Klíč „stejný doklad od stejného dodavatele“. S IČO se dodavatel určuje IČO, bez IČO názvem.
 * `cislo` musí být ve stejné podobě jako v DBF (sanitované a ořezané na 20 znaků).
 */
export function dokladKey(ico: string | null, nazev: string, cislo: string): string {
  return ico !== null
    ? JSON.stringify(["ico", normalizeIco(ico), cislo.trim()])
    : JSON.stringify(["nazev", nazev.trim(), cislo.trim()]);
}

interface Hits {
  zive: FakturaPrijata[];
  smazane: FakturaPrijata[];
}

export interface DedupIndex {
  markers: Map<string, Hits>;
  cisla: Map<string, Hits>;
}

function addHit(map: Map<string, Hits>, key: string, f: FakturaPrijata): void {
  let h = map.get(key);
  if (!h) {
    h = { zive: [], smazane: [] };
    map.set(key, h);
  }
  (f.smazano ? h.smazane : h.zive).push(f);
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
  const cisla = new Map<string, Hits>();
  for (const f of data.faktury) {
    for (const id of extractTaxyIds(f.poznamka)) addHit(markers, id, f);
    const partner = f.partnerId === null ? undefined : partners.get(f.partnerId);
    if (partner !== undefined) addHit(cisla, dokladKey(partner.ico, partner.nazev, f.cisloDodavatele), f);
  }
  return { markers, cisla };
}

const NONE: Hits = { zive: [], smazane: [] };

export function lookupMarker(index: DedupIndex, docId: string): Hits {
  return index.markers.get(docId) ?? NONE;
}

export function lookupNumber(index: DedupIndex, key: string): Hits {
  return index.cisla.get(key) ?? NONE;
}
