// Načtení a striktní validace vstupů z TAXY (klienti.json, doklady-k-zapisu.json).
// Vstup je nedůvěryhodný: kontrolujeme typy, hodnoty, délky a velikost souboru.
//
// Dvě úrovně chyb:
//  - chyba celého souboru (nečitelný, nevalidní JSON, špatná struktura, příliš velký) →
//    `VstupniChyba` (CLI skončí s exit kódem 1);
//  - chyba jednoho dokladu → doklad se odmítne s českým důvodem, ostatní se zpracují.

import * as fs from "node:fs";
import { TextDecoder } from "node:util";
import { VstupniChyba } from "../errors";
import {
  AMOUNT_RE, DATE_RE, ICO_RE, KURZ_RE, MENA_RE, STAT_RE, isValidIsoDate, normalizeIco,
} from "../kaktus/format";
import { FIRMA_ID_RE } from "../kaktus/read";

export const MAX_KLIENTI_BYTES = 1024 * 1024;
export const MAX_DOKLADY_BYTES = 10 * 1024 * 1024;
export const MAX_KLIENTU = 10_000;
export const MAX_DOKLADU = 5_000;

/** ID dokladu končí v poznámce `TAXY:<id>` (60 znaků), proto je krátké a jen z bezpečných znaků. */
export const DOC_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const MAX_NAME = 200;
const MAX_TEXT = 1000;
const MAX_SHORT = 100;

export interface Klient {
  klientId: number;
  nazev: string;
  /** IČO doplněné na 8 číslic. */
  ico: string;
  kaktusFirma: string;
}

export interface TaxyDodavatel {
  nazev: string;
  /** IČO doplněné na 8 číslic; null = bez IČO. */
  ico: string | null;
  dic: string | null;
  ulice: string | null;
  mesto: string | null;
  psc: string | null;
  stat: string | null;
}

/** Zvalidovaný doklad z TAXY. Částky jsou v haléřích, kurz zůstává řetězcem (bez float chyb). */
export interface TaxyDoklad {
  id: string;
  klientId: number;
  cisloDokladu: string;
  variabilniSymbol: string | null;
  dodavatel: TaxyDodavatel;
  /** IČO odběratele doplněné na 8 číslic. */
  odberatelIco: string;
  datumVystaveni: string;
  duzp: string | null;
  datumSplatnosti: string | null;
  zaklad0: number;
  zaklad12: number;
  dph12: number;
  zaklad21: number;
  dph21: number;
  celkem: number;
  mena: string;
  kurz: string | null;
  popis: string | null;
  /** Upozornění z validace (např. ignorovaný kurz u CZK). */
  varovani: string[];
}

// ---------------------------------------------------------------------------
// Načtení souborů
// ---------------------------------------------------------------------------

/** Přečte JSON soubor s omezením velikosti (UTF-8, případný BOM se ignoruje). */
export function readJsonFile(file: string, maxBytes: number, label: string): unknown {
  let size: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new VstupniChyba(`${label}: ${file} není soubor.`);
    size = st.size;
  } catch (e) {
    if (e instanceof VstupniChyba) throw e;
    throw new VstupniChyba(`${label}: soubor ${file} nelze přečíst.`);
  }
  if (size > maxBytes) {
    throw new VstupniChyba(`${label}: soubor je větší než povolených ${Math.round(maxBytes / 1024)} KiB.`);
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    throw new VstupniChyba(`${label}: soubor ${file} nelze přečíst.`);
  }
  if (buf.length > maxBytes) throw new VstupniChyba(`${label}: soubor je větší než povoleno.`);
  return parseJsonBuffer(buf, label);
}

/** Čistá část načtení: bajty → JSON; chyba = `VstupniChyba`. */
export function parseJsonBuffer(buf: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new VstupniChyba(`${label}: soubor není v kódování UTF-8.`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw new VstupniChyba(`${label}: soubor není platný JSON.`);
  }
}

export function loadKlienti(file: string): Klient[] {
  return parseKlienti(readJsonFile(file, MAX_KLIENTI_BYTES, "klienti.json"));
}

/** Vrátí surové doklady (každý se validuje zvlášť, chybný doklad nesmí zahodit ostatní). */
export function loadDoklady(file: string): unknown[] {
  return parseDokladyFile(readJsonFile(file, MAX_DOKLADY_BYTES, "doklady"));
}

// ---------------------------------------------------------------------------
// Validace (čisté funkce)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Vlastní vlastnost objektu (ne zděděná). */
function prop(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

export function parseKlienti(json: unknown): Klient[] {
  if (!isObject(json)) throw new VstupniChyba("klienti.json: očekáván objekt s polem „klienti“.");
  const list = prop(json, "klienti");
  if (!Array.isArray(list) || list.length === 0) {
    throw new VstupniChyba("klienti.json: pole „klienti“ chybí nebo je prázdné.");
  }
  if (list.length > MAX_KLIENTU) throw new VstupniChyba("klienti.json: příliš mnoho klientů.");
  const out: Klient[] = [];
  const ids = new Set<number>();
  const firmy = new Set<string>();
  list.forEach((item: unknown, i: number) => {
    const where = `klienti.json: klient č. ${i + 1}`;
    if (!isObject(item)) throw new VstupniChyba(`${where} není objekt.`);
    const klientId = prop(item, "klientId");
    const nazev = prop(item, "nazev");
    const ico = prop(item, "ico");
    const firma = prop(item, "kaktusFirma");
    if (typeof klientId !== "number" || !Number.isSafeInteger(klientId) || klientId <= 0) {
      throw new VstupniChyba(`${where}: „klientId“ musí být kladné celé číslo.`);
    }
    if (typeof nazev !== "string" || nazev.trim() === "" || nazev.length > MAX_NAME) {
      throw new VstupniChyba(`${where}: „nazev“ chybí nebo je neplatný.`);
    }
    if (typeof ico !== "string" || !ICO_RE.test(ico)) {
      throw new VstupniChyba(`${where}: „ico“ musí mít 1 až 8 číslic.`);
    }
    if (typeof firma !== "string" || !FIRMA_ID_RE.test(firma)) {
      throw new VstupniChyba(`${where}: „kaktusFirma“ musí mít přesně 4 číslice.`);
    }
    if (ids.has(klientId)) throw new VstupniChyba(`klienti.json: klientId ${klientId} je uvedeno vícekrát.`);
    if (firmy.has(firma)) {
      throw new VstupniChyba(`klienti.json: firma ${firma} je přiřazena více klientům; takovou konfiguraci nepodporujeme.`);
    }
    ids.add(klientId);
    firmy.add(firma);
    out.push({ klientId, nazev, ico: normalizeIco(ico), kaktusFirma: firma });
  });
  return out;
}

export function parseDokladyFile(json: unknown): unknown[] {
  if (!Array.isArray(json)) throw new VstupniChyba("Soubor s doklady musí obsahovat pole dokladů.");
  if (json.length > MAX_DOKLADU) {
    throw new VstupniChyba(`Soubor s doklady obsahuje víc než ${MAX_DOKLADU} dokladů.`);
  }
  return json;
}

/** ID dokladu, je-li platné; jinak null (pro hlášení v reportu). */
export function peekDocId(raw: unknown): string | null {
  if (!isObject(raw)) return null;
  const id = prop(raw, "id");
  return typeof id === "string" && DOC_ID_RE.test(id) ? id : null;
}

export interface DokladIdentita {
  id: string;
  klientId: number;
  /** IČO odběratele doplněné na 8 číslic. */
  odberatelIco: string;
}

export type IdentitaVysledek =
  | { ok: true; identita: DokladIdentita }
  | { ok: false; id: string | null; klientId: number | null; duvody: string[] };

/** Minimum nutné k autorizaci: id dokladu, klientId a IČO odběratele. */
export function parseIdentita(raw: unknown): IdentitaVysledek {
  if (!isObject(raw)) return { ok: false, id: null, klientId: null, duvody: ["Doklad není objekt."] };
  const duvody: string[] = [];
  const id = peekDocId(raw);
  if (id === null) duvody.push("Chybí platné „id“ dokladu (1–40 znaků A–Z, a–z, 0–9, _ a -).");
  const kid = prop(raw, "klientId");
  const klientId = typeof kid === "number" && Number.isSafeInteger(kid) && kid > 0 ? kid : null;
  if (klientId === null) duvody.push("Chybí platné „klientId“ (kladné celé číslo).");
  const odb = prop(raw, "odberatel");
  const icoRaw = isObject(odb) ? prop(odb, "ico") : undefined;
  const odberatelIco = typeof icoRaw === "string" && ICO_RE.test(icoRaw) ? normalizeIco(icoRaw) : null;
  if (odberatelIco === null) duvody.push("Chybí platné IČO odběratele.");
  if (duvody.length > 0 || id === null || klientId === null || odberatelIco === null) {
    return { ok: false, id, klientId, duvody };
  }
  return { ok: true, identita: { id, klientId, odberatelIco } };
}

/** Čtečka polí, která sbírá chyby (české hlášky) místo vyhazování výjimek. */
class Fields {
  readonly errors: string[] = [];
  constructor(private readonly o: Record<string, unknown>, private readonly prefix: string) {}

  private name(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** Nepovinný řetězec: chybějící/null → null; prázdný (po ořezu mezer) → null. */
  optString(key: string, max: number): string | null {
    const v = prop(this.o, key);
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      this.errors.push(`Pole „${this.name(key)}“ musí být text.`);
      return null;
    }
    if (v.length > max) {
      this.errors.push(`Pole „${this.name(key)}“ je delší než ${max} znaků.`);
      return null;
    }
    return v.trim() === "" ? null : v;
  }

  reqString(key: string, max: number): string | null {
    const v = this.optString(key, max);
    if (v === null && !this.errors.some((e) => e.includes(`„${this.name(key)}“`))) {
      this.errors.push(`Pole „${this.name(key)}“ chybí nebo je prázdné.`);
    }
    return v;
  }

  optDate(key: string): string | null {
    const v = this.optString(key, 10);
    if (v === null) return null;
    if (!DATE_RE.test(v) || !isValidIsoDate(v)) {
      this.errors.push(`Pole „${this.name(key)}“ není platné datum RRRR-MM-DD.`);
      return null;
    }
    return v;
  }

  reqDate(key: string): string | null {
    const v = this.optDate(key);
    if (v === null && !this.errors.some((e) => e.includes(`„${this.name(key)}“`))) {
      this.errors.push(`Pole „${this.name(key)}“ chybí.`);
    }
    return v;
  }

  optIco(key: string): string | null {
    const v = this.optString(key, 8);
    if (v === null) return null;
    if (!ICO_RE.test(v)) {
      this.errors.push(`Pole „${this.name(key)}“ musí mít 1 až 8 číslic.`);
      return null;
    }
    return normalizeIco(v);
  }
}

/**
 * Částka z JSONu (číslo) → haléře. Použije se nejkratší textový zápis čísla a regex Kaktusu
 * (max. 8 číslic, max. 2 desetinná místa), takže 0.1 + 0.2 apod. neprojde a nic se nezaokrouhluje.
 */
export function amountToCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const text = String(v);
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m || !AMOUNT_RE.test(text)) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

/** Kurz z JSONu (číslo) → řetězec ve formátu Kaktusu; null při neplatné hodnotě. */
export function kurzToString(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const text = String(v);
  return KURZ_RE.test(text) && v > 0 ? text : null;
}

const SAZBY = [0, 12, 21] as const;

/** Plná validace jednoho dokladu. Neověřuje autorizaci (ta je nadřazená, viz plan.ts). */
export function parseDoklad(raw: unknown): { ok: true; doklad: TaxyDoklad } | { ok: false; duvody: string[] } {
  if (!isObject(raw)) return { ok: false, duvody: ["Doklad není objekt."] };
  const f = new Fields(raw, "");
  const varovani: string[] = [];

  if (prop(raw, "typ") !== "faktura_prijata") f.errors.push("Nepodporovaný typ dokladu (očekáváno faktura_prijata).");
  if (prop(raw, "stav") !== "schvaleno") f.errors.push("Doklad není ve stavu „schváleno“.");

  const ident = parseIdentita(raw);
  if (!ident.ok) f.errors.push(...ident.duvody);

  const cisloDokladu = f.reqString("cisloDokladu", MAX_SHORT);
  const variabilniSymbol = f.optString("variabilniSymbol", MAX_SHORT);
  const popis = f.optString("popis", MAX_TEXT);
  const datumVystaveni = f.reqDate("datumVystaveni");
  const duzp = f.optDate("duzp");
  const datumSplatnosti = f.optDate("datumSplatnosti");

  // Dodavatel
  let dodavatel: TaxyDodavatel | null = null;
  const dodRaw = prop(raw, "dodavatel");
  if (!isObject(dodRaw)) {
    f.errors.push("Chybí objekt „dodavatel“.");
  } else {
    const d = new Fields(dodRaw, "dodavatel.");
    const nazev = d.reqString("nazev", MAX_NAME);
    const ico = d.optIco("ico");
    const dic = d.optString("dic", MAX_SHORT);
    const ulice = d.optString("ulice", MAX_NAME);
    const mesto = d.optString("mesto", MAX_NAME);
    const psc = d.optString("psc", MAX_SHORT);
    const stat = d.optString("stat", 2);
    if (stat !== null && !STAT_RE.test(stat)) d.errors.push("Pole „dodavatel.stat“ musí být dvoupísmenný kód státu.");
    f.errors.push(...d.errors);
    if (nazev !== null && d.errors.length === 0) {
      dodavatel = { nazev, ico, dic, ulice, mesto, psc, stat: stat === null ? null : stat.toUpperCase() };
    }
  }

  // Měna a kurz
  const mena = f.reqString("mena", 3);
  if (mena !== null && !MENA_RE.test(mena)) f.errors.push("Pole „mena“ musí být třípísmenný kód velkými písmeny.");
  let kurz: string | null = null;
  const kurzRaw = prop(raw, "kurz");
  if (mena !== null && MENA_RE.test(mena)) {
    if (mena === "CZK") {
      if (kurzRaw !== undefined && kurzRaw !== null) varovani.push("Kurz u dokladu v CZK se ignoruje.");
    } else {
      kurz = kurzToString(kurzRaw);
      if (kurz === null) f.errors.push("U dokladu v cizí měně chybí platný kurz (kladné číslo, max. 4+4 číslice).");
    }
  }

  // Částky a rozpis DPH
  const sums = { zaklad0: 0, zaklad12: 0, dph12: 0, zaklad21: 0, dph21: 0 };
  const rozpis = prop(raw, "rozpisDph");
  if (!Array.isArray(rozpis) || rozpis.length === 0 || rozpis.length > SAZBY.length) {
    f.errors.push("Pole „rozpisDph“ musí obsahovat 1 až 3 položky.");
  } else {
    const seen = new Set<number>();
    rozpis.forEach((item: unknown, i: number) => {
      const w = `rozpisDph[${i + 1}]`;
      if (!isObject(item)) {
        f.errors.push(`${w} není objekt.`);
        return;
      }
      const sazba = prop(item, "sazba");
      const zaklad = amountToCents(prop(item, "zaklad"));
      const dph = amountToCents(prop(item, "dph"));
      if (typeof sazba !== "number" || !(SAZBY as readonly number[]).includes(sazba)) {
        f.errors.push(`${w}: nepodporovaná sazba DPH (povoleno 0, 12, 21).`);
        return;
      }
      if (seen.has(sazba)) {
        f.errors.push(`${w}: sazba ${sazba} je v rozpisu uvedena vícekrát.`);
        return;
      }
      seen.add(sazba);
      if (zaklad === null || dph === null) {
        f.errors.push(`${w}: neplatná částka (nejvýše 8 číslic a 2 desetinná místa).`);
        return;
      }
      if (sazba === 0) {
        if (dph !== 0) f.errors.push(`${w}: u sazby 0 % musí být daň nulová.`);
        sums.zaklad0 = zaklad;
      } else if (sazba === 12) {
        sums.zaklad12 = zaklad;
        sums.dph12 = dph;
      } else {
        sums.zaklad21 = zaklad;
        sums.dph21 = dph;
      }
    });
  }
  const celkem = amountToCents(prop(raw, "celkem"));
  if (celkem === null) f.errors.push("Pole „celkem“ chybí nebo není platná částka (nejvýše 8 číslic a 2 desetinná místa).");

  // Odběratel (pro autorizaci řeší parseIdentita, tady jen jeho hodnota do výsledku)
  if (f.errors.length > 0 || !ident.ok || cisloDokladu === null || datumVystaveni === null || dodavatel === null ||
      mena === null || celkem === null) {
    return { ok: false, duvody: f.errors };
  }
  return {
    ok: true,
    doklad: {
      id: ident.identita.id,
      klientId: ident.identita.klientId,
      cisloDokladu,
      variabilniSymbol,
      dodavatel,
      odberatelIco: ident.identita.odberatelIco,
      datumVystaveni,
      duzp,
      datumSplatnosti,
      ...sums,
      celkem,
      mena,
      kurz,
      popis,
      varovani,
    },
  };
}
