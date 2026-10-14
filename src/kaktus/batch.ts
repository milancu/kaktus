// Stavba XML dávky pro import do Kaktusu (čisté funkce bez I/O).
//
// Pravidla:
//  - každá textová hodnota jde přes jedinou funkci `escapeXml`;
//  - názvy elementů jsou konstanty (typ `ElementName`), z dat se nikdy neskládají;
//  - dávka je Win-1250 bez BOM (tak ji Kaktus čte) a obsahuje nejvýše 20 dokladů
//    (Kaktus zbytek potichu ignoruje);
//  - částky jsou v haléřích a na text se převádějí až tady.

import { encodeWin1250, isXmlChar } from "../codec";
import { AMOUNT_OUT_RE, DATE_RE, ICO_RE, KURZ_RE, MENA_RE } from "./format";
import { FIRMA_ID_RE, centsToDecimal } from "./read";

/** Kaktus zpracuje jen prvních 20 dokladů dávky. */
export const MAX_BATCH_SIZE = 20;

export interface BatchDodavatel {
  nazev: string;
  /** IČO bez mezer, 1–8 číslic; null = bez IČO. */
  ico: string | null;
  dic: string;
  ulice: string;
  mesto: string;
  psc: string;
  /** Dvoupísmenný kód státu; prázdné = nechat na Kaktusu (výchozí CZ). */
  stat: string;
}

/** Doklad připravený k zápisu: texty už sanitované a ořezané, částky v haléřích. */
export interface BatchDoklad {
  cisloDodavatele: string;
  variabilniSymbol: string;
  dodavatel: BatchDodavatel;
  datumVystaveni: string;
  datumZdanPlneni: string | null;
  datumSplatnosti: string | null;
  zaklad0: number;
  zaklad12: number;
  dph12: number;
  zaklad21: number;
  dph21: number;
  celkem: number;
  mena: string;
  /** Kurz jako desetinný řetězec; povinný jen u cizí měny. */
  kurz: string | null;
  text: string;
  poznamka: string;
}

/** Jediné povolené názvy elementů. */
type ElementName =
  | "FakturaPrijata" | "CisloDodavatele" | "VarSymbol" | "Dodavatel" | "Nazev"
  | "ICO" | "DIC" | "Ulice" | "Mesto" | "PSC" | "Stat" | "DatumVystaveni" | "DatumZdanPlneni"
  | "DatumSplatnosti" | "Zaklad0" | "Zaklad12" | "DPH12" | "Zaklad21" | "DPH21" | "Celkem"
  | "Mena" | "Kurz" | "Text" | "Poznamka";

/**
 * Jediná escape funkce pro hodnoty v XML. Nejdřív zahodí znaky neplatné v XML 1.0 (řídicí
 * znaky, nepárové surrogáty), potom nahradí `& < > " '`.
 */
export function escapeXml(value: string): string {
  let out = "";
  for (const ch of value) {
    if (!isXmlChar(ch.codePointAt(0) as number)) continue;
    switch (ch) {
      case "&": out += "&amp;"; break;
      case "<": out += "&lt;"; break;
      case ">": out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case "'": out += "&apos;"; break;
      default: out += ch;
    }
  }
  return out;
}

/** Haléře → text částky s tečkou a dvěma desetinnými místy (např. 244057 → "2440.57"). */
export function formatCents(cents: number): string {
  const text = centsToDecimal(cents);
  if (!AMOUNT_OUT_RE.test(text)) throw new Error("Částka je mimo rozsah formátu Kaktusu.");
  return text;
}

function el(name: ElementName, value: string, indent: string): string {
  return `${indent}<${name}>${escapeXml(value)}</${name}>\n`;
}

function elIf(name: ElementName, value: string | null, indent: string): string {
  return value === null || value === "" ? "" : el(name, value, indent);
}

function requireFormat(re: RegExp, value: string, what: string): string {
  if (!re.test(value)) throw new Error(`Neplatná hodnota pole ${what} v dávce.`);
  return value;
}

function optionalFormat(re: RegExp, value: string | null, what: string): string | null {
  return value === null ? null : requireFormat(re, value, what);
}

function buildDokladXml(d: BatchDoklad): string {
  const i1 = "  ";
  const i2 = "    ";
  const i3 = "      ";
  const dod = d.dodavatel;
  let s = `${i1}<FakturaPrijata>\n`;
  s += el("CisloDodavatele", d.cisloDodavatele, i2);
  s += elIf("VarSymbol", d.variabilniSymbol, i2);
  s += `${i2}<Dodavatel>\n`;
  s += el("Nazev", dod.nazev, i3);
  s += elIf("ICO", optionalFormat(ICO_RE, dod.ico, "ICO"), i3);
  s += elIf("DIC", dod.dic, i3);
  s += elIf("Ulice", dod.ulice, i3);
  s += elIf("Mesto", dod.mesto, i3);
  s += elIf("PSC", dod.psc, i3);
  s += elIf("Stat", dod.stat, i3);
  s += `${i2}</Dodavatel>\n`;
  s += el("DatumVystaveni", requireFormat(DATE_RE, d.datumVystaveni, "DatumVystaveni"), i2);
  s += elIf("DatumZdanPlneni", optionalFormat(DATE_RE, d.datumZdanPlneni, "DatumZdanPlneni"), i2);
  s += elIf("DatumSplatnosti", optionalFormat(DATE_RE, d.datumSplatnosti, "DatumSplatnosti"), i2);
  s += el("Zaklad0", formatCents(d.zaklad0), i2);
  s += el("Zaklad12", formatCents(d.zaklad12), i2);
  s += el("DPH12", formatCents(d.dph12), i2);
  s += el("Zaklad21", formatCents(d.zaklad21), i2);
  s += el("DPH21", formatCents(d.dph21), i2);
  s += el("Celkem", formatCents(d.celkem), i2);
  s += el("Mena", requireFormat(MENA_RE, d.mena, "Mena"), i2);
  s += elIf("Kurz", optionalFormat(KURZ_RE, d.kurz, "Kurz"), i2);
  s += el("Text", d.text, i2);
  s += el("Poznamka", d.poznamka, i2);
  s += `${i1}</FakturaPrijata>\n`;
  return s;
}

/**
 * Sestaví dávku pro jednu firmu: Win-1250, bez BOM, deklarace `windows-1250`.
 * Hází `Error` při porušení kontraktu (neplatné ID firmy, prázdná nebo příliš velká dávka);
 * to je chyba programu, ne vstupu.
 */
export function buildBatchXml(firma: string, doklady: readonly BatchDoklad[]): Buffer {
  if (!FIRMA_ID_RE.test(firma)) throw new Error("ID firmy v dávce musí mít 4 číslice.");
  if (doklady.length === 0) throw new Error("Dávka nesmí být prázdná.");
  if (doklady.length > MAX_BATCH_SIZE) {
    throw new Error(`Dávka smí mít nejvýše ${MAX_BATCH_SIZE} dokladů (Kaktus by zbytek potichu ignoroval).`);
  }
  let xml = '<?xml version="1.0" encoding="windows-1250"?>\n';
  xml += `<KaktusDavka verze="3.2" firma="${firma}">\n`;
  for (const d of doklady) xml += buildDokladXml(d);
  xml += "</KaktusDavka>\n";
  return encodeWin1250(xml);
}

/** Jedna dávka: i-tá položka má v odpovědi Kaktusu `poradi = i + 1`. */
export interface Davka<T> {
  firma: string;
  polozky: T[];
  xml: Buffer;
}

/** Rozdělí doklady jedné firmy na dávky po nejvýše `maxSize` (výchozí a maximální 20). */
export function buildBatches<T extends { doklad: BatchDoklad }>(
  firma: string,
  items: readonly T[],
  maxSize: number = MAX_BATCH_SIZE,
): Davka<T>[] {
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > MAX_BATCH_SIZE) {
    throw new Error(`Velikost dávky musí být 1 až ${MAX_BATCH_SIZE}.`);
  }
  const out: Davka<T>[] = [];
  for (let i = 0; i < items.length; i += maxSize) {
    const polozky = items.slice(i, i + maxSize);
    out.push({ firma, polozky, xml: buildBatchXml(firma, polozky.map((p) => p.doklad)) });
  }
  return out;
}
