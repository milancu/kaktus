// Čtení dat Kaktusu: FIRMY, ADRESAR, FAKPRI → doménové objekty.
// Funkce jsou navržené pro opětovné použití v zápisu (readFirmaData podle ID firmy).
// Smazané záznamy se nevynechávají, jsou označené `smazano: true`.

import * as fs from "node:fs";
import * as path from "node:path";
import { readDbfFile } from "../dbf";
import type { DbfFieldType, DbfRecord, DbfTable } from "../dbf";
import { VstupniChyba } from "../errors";

export const FIRMA_ID_RE = /^\d{4}$/;
export const SLOZKA_RE = /^[A-Za-z0-9_-]{1,8}$/;
const ICO_RE = /^\d{1,8}$/;

export interface Firma {
  id: string;
  nazev: string;
  /** IČO doplněné na 8 číslic. */
  ico: string | null;
  dic: string | null;
  slozka: string;
  platceDph: boolean | null;
  smazano: boolean;
}

export interface Dodavatel {
  id: number;
  nazev: string;
  /** IČO doplněné na 8 číslic (v DBF je číselné, úvodní nuly se ztrácejí). */
  ico: string | null;
  dic: string | null;
  ulice: string;
  mesto: string;
  psc: string;
  stat: string;
  ucet: string;
  poznamka: string;
  smazano: boolean;
}

/** Částky jsou v haléřích (celá čísla), data ve formátu ISO `RRRR-MM-DD`. */
export interface FakturaPrijata {
  id: number;
  doklad: string;
  cisloDodavatele: string;
  variabilniSymbol: string;
  /** Odkaz na `Dodavatel.id` (ADRESAR.ID). */
  partnerId: number | null;
  datumVystaveni: string | null;
  datumZdanitelnehoPlneni: string | null;
  datumSplatnosti: string | null;
  datumUhrady: string | null;
  zaklad0: number | null;
  zaklad12: number | null;
  dph12: number | null;
  zaklad21: number | null;
  dph21: number | null;
  celkem: number | null;
  mena: string;
  kurz: number | null;
  text: string;
  poznamka: string;
  smazano: boolean;
}

export interface FirmaData {
  firma: Firma;
  dodavatele: Dodavatel[];
  faktury: FakturaPrijata[];
}

/** Načtená firma; u smazané firmy jsou `dodavatele` a `faktury` null (data se nečtou). */
export type FirmaNactena = Firma & { dodavatele: Dodavatel[] | null; faktury: FakturaPrijata[] | null };

export interface KaktusData {
  firmy: FirmaNactena[];
}

type CastkaPole = "zaklad0" | "zaklad12" | "dph12" | "zaklad21" | "dph21" | "celkem";
const CASTKA_POLE: readonly CastkaPole[] = ["zaklad0", "zaklad12", "dph12", "zaklad21", "dph21", "celkem"];

/**
 * Faktura ve výstupu `cist`: částky jsou desetinné řetězce v měně dokladu s tečkou a dvěma
 * desetinnými místy ("2360.00"), kurz řetězec se čtyřmi místy ("24.3150"). Haléře jako čísla
 * by šlo snadno přečíst stokrát větší a float by u částek ztrácel přesnost.
 */
export type FakturaVystup = Omit<FakturaPrijata, CastkaPole | "kurz"> &
  { [K in CastkaPole]: string | null } & { kurz: string | null };

export type FirmaVystup = Firma & { dodavatele: Dodavatel[] | null; faktury: FakturaVystup[] | null };

export interface KaktusVystup {
  format: 2;
  firmy: FirmaVystup[];
}

// ---------------------------------------------------------------------------
// Čisté pomocné funkce (bez I/O)
// ---------------------------------------------------------------------------

/** Převede text částky z DBF (např. `2440.57`, `-12`) na haléře. Nic nezaokrouhluje, nepoužívá float. */
export function parseCents(text: string, where: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new VstupniChyba(`Neplatná částka "${text}" (${where}).`);
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) throw new VstupniChyba(`Částka je mimo rozsah (${where}).`);
  return m[1] === "-" ? -cents : cents;
}

/** Haléře → desetinný text s tečkou a dvěma místy (244057 → "2440.57"). Bez floatu. */
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("Částka musí být celé číslo haléřů.");
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function parseInteger(text: string, where: string): number {
  if (!/^-?\d{1,15}$/.test(text)) throw new VstupniChyba(`Neplatné celé číslo "${text}" (${where}).`);
  return Number(text);
}

/** Číselné IČO z DBF → 8 číslic s úvodními nulami. */
export function icoFromNumber(value: number, where: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 99999999) {
    throw new VstupniChyba(`Neplatné IČO ${value} (${where}).`);
  }
  return String(value).padStart(8, "0");
}

/** IČO z textového pole (FIRMY.ICO): prázdné → null, jinak 1–8 číslic doplněných nulami na 8. */
export function icoFromText(text: string, where: string): string | null {
  const t = text.trim();
  if (t === "") return null;
  if (!ICO_RE.test(t)) throw new VstupniChyba(`Neplatné IČO "${t}" (${where}).`);
  return t.padStart(8, "0");
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== "..";
}

function requireFields(table: DbfTable, label: string, spec: Record<string, DbfFieldType>): void {
  for (const [name, type] of Object.entries(spec)) {
    const f = table.fields.find((x) => x.name === name);
    if (!f || f.type !== type) {
      throw new VstupniChyba(`Soubor ${label} nemá očekávané pole ${name} (${type}).`);
    }
  }
}

function str(rec: DbfRecord, name: string): string {
  const v = rec.values.get(name);
  return typeof v === "string" ? v : "";
}

function strOrNull(rec: DbfRecord, name: string): string | null {
  const s = str(rec, name).trim();
  return s === "" ? null : s;
}

function num(rec: DbfRecord, name: string): string | null {
  const v = rec.values.get(name);
  return typeof v === "string" ? v : null;
}

function date(rec: DbfRecord, name: string): string | null {
  const v = rec.values.get(name);
  return typeof v === "string" ? v : null;
}

function where(label: string, rec: DbfRecord, name: string): string {
  return `${label}, záznam ${rec.index + 1}, pole ${name}`;
}

function intField(rec: DbfRecord, name: string, label: string): number | null {
  const t = num(rec, name);
  return t === null ? null : parseInteger(t, where(label, rec, name));
}

function centsField(rec: DbfRecord, name: string, label: string): number | null {
  const t = num(rec, name);
  return t === null ? null : parseCents(t, where(label, rec, name));
}

// ---------------------------------------------------------------------------
// Převod tabulek na doménové objekty (čisté funkce)
// ---------------------------------------------------------------------------

export function mapFirmy(table: DbfTable, label: string): Firma[] {
  requireFields(table, label, { ID: "C", NAZEV: "C", ICO: "C", DIC: "C", SLOZKA: "C", PLATCE: "L" });
  return table.records.map((rec) => {
    const platce = rec.values.get("PLATCE");
    const w = where(label, rec, "ICO");
    return {
      id: str(rec, "ID").trim(),
      nazev: str(rec, "NAZEV"),
      // U smazané firmy neřešíme případnou vadu IČO – data stejně nepoužijeme.
      ico: rec.deleted ? strOrNull(rec, "ICO") : icoFromText(str(rec, "ICO"), w),
      dic: strOrNull(rec, "DIC"),
      slozka: str(rec, "SLOZKA").trim(),
      platceDph: typeof platce === "boolean" ? platce : null,
      smazano: rec.deleted,
    };
  });
}

export function mapDodavatele(table: DbfTable, label: string): Dodavatel[] {
  requireFields(table, label, {
    ID: "N", NAZEV: "C", ICO: "N", DIC: "C", ULICE: "C", MESTO: "C", PSC: "C", STAT: "C", UCET: "C", POZN: "C",
  });
  return table.records.map((rec) => {
    const id = intField(rec, "ID", label);
    if (id === null) throw new VstupniChyba(`Chybí ID (${where(label, rec, "ID")}).`);
    const icoNum = intField(rec, "ICO", label);
    return {
      id,
      nazev: str(rec, "NAZEV"),
      ico: icoNum === null ? null : icoFromNumber(icoNum, where(label, rec, "ICO")),
      dic: strOrNull(rec, "DIC"),
      ulice: str(rec, "ULICE"),
      mesto: str(rec, "MESTO"),
      psc: str(rec, "PSC"),
      stat: str(rec, "STAT"),
      ucet: str(rec, "UCET"),
      poznamka: str(rec, "POZN"),
      smazano: rec.deleted,
    };
  });
}

export function mapFaktury(table: DbfTable, label: string): FakturaPrijata[] {
  requireFields(table, label, {
    ID: "N", DOKLAD: "C", CISLODOD: "C", VS: "C", PARTNER: "N",
    DATVYST: "D", DATZDAN: "D", DATSPL: "D", DATUHR: "D",
    ZAKL0: "N", ZAKL12: "N", DPH12: "N", ZAKL21: "N", DPH21: "N", CELKEM: "N",
    MENA: "C", KURZ: "N", TEXT: "C", POZN: "C",
  });
  return table.records.map((rec) => {
    const id = intField(rec, "ID", label);
    if (id === null) throw new VstupniChyba(`Chybí ID (${where(label, rec, "ID")}).`);
    const kurzText = num(rec, "KURZ");
    let kurz: number | null = null;
    if (kurzText !== null) {
      if (!/^-?\d+(\.\d{1,4})?$/.test(kurzText)) {
        throw new VstupniChyba(`Neplatný kurz "${kurzText}" (${where(label, rec, "KURZ")}).`);
      }
      kurz = Number(kurzText);
    }
    return {
      id,
      doklad: str(rec, "DOKLAD"),
      cisloDodavatele: str(rec, "CISLODOD"),
      variabilniSymbol: str(rec, "VS"),
      partnerId: intField(rec, "PARTNER", label),
      datumVystaveni: date(rec, "DATVYST"),
      datumZdanitelnehoPlneni: date(rec, "DATZDAN"),
      datumSplatnosti: date(rec, "DATSPL"),
      datumUhrady: date(rec, "DATUHR"),
      zaklad0: centsField(rec, "ZAKL0", label),
      zaklad12: centsField(rec, "ZAKL12", label),
      dph12: centsField(rec, "DPH12", label),
      zaklad21: centsField(rec, "ZAKL21", label),
      dph21: centsField(rec, "DPH21", label),
      celkem: centsField(rec, "CELKEM", label),
      mena: str(rec, "MENA"),
      kurz,
      text: str(rec, "TEXT"),
      poznamka: str(rec, "POZN"),
      smazano: rec.deleted,
    };
  });
}

// ---------------------------------------------------------------------------
// Cesty (path traversal) a čtení ze souborů
// ---------------------------------------------------------------------------

/**
 * Vrátí absolutní cestu ke složce firmy uvnitř `DATA/`. Validuje ID i SLOZKA regexem,
 * `path.resolve` a po rozlišení symlinků ověří, že cesta leží uvnitř `DATA/`.
 *
 * SLOZKA musí být rovna ID firmy: import Kaktusu hledá složku podle ID, takže jiná složka
 * by znamenala, že čteme jinde, než kam se zapisuje (viz docs/ROZHODNUTI.md).
 */
export function resolveFirmaDir(kaktusDir: string, firma: Firma): string {
  if (!FIRMA_ID_RE.test(firma.id)) throw new VstupniChyba(`Neplatné ID firmy "${firma.id}" (očekáváno 4 číslice).`);
  if (!SLOZKA_RE.test(firma.slozka)) throw new VstupniChyba(`Neplatná složka firmy ${firma.id}.`);
  if (firma.slozka !== firma.id) {
    throw new VstupniChyba(`Složka firmy ${firma.id} se liší od jejího ID; takovou konfiguraci nepodporujeme.`);
  }
  const dataDir = path.resolve(kaktusDir, "DATA");
  const dir = path.resolve(dataDir, firma.slozka);
  if (!isInside(dataDir, dir)) throw new VstupniChyba(`Složka firmy ${firma.id} leží mimo DATA.`);
  let realData: string;
  let realDir: string;
  try {
    realData = fs.realpathSync(dataDir);
    realDir = fs.realpathSync(dir);
  } catch {
    throw new VstupniChyba(`Složka firmy ${firma.id} neexistuje.`);
  }
  if (!isInside(realData, realDir)) throw new VstupniChyba(`Složka firmy ${firma.id} leží mimo DATA.`);
  return dir;
}

export function readFirmy(kaktusDir: string): Firma[] {
  const label = "DATA/FIRMY.DBF";
  const firmy = mapFirmy(readDbfFile(path.resolve(kaktusDir, "DATA", "FIRMY.DBF"), label), label);
  const seen = new Set<string>();
  for (const f of firmy) {
    if (f.smazano) continue;
    if (seen.has(f.id)) throw new VstupniChyba(`Firma ${f.id} je ve FIRMY.DBF uvedena vícekrát.`);
    seen.add(f.id);
  }
  return firmy;
}

export function readDodavatele(firmaDir: string, firmaId: string): Dodavatel[] {
  const label = `DATA/${firmaId}/ADRESAR.DBF`;
  return mapDodavatele(readDbfFile(path.join(firmaDir, "ADRESAR.DBF"), label), label);
}

export function readFaktury(firmaDir: string, firmaId: string): FakturaPrijata[] {
  const label = `DATA/${firmaId}/FAKPRI.DBF`;
  return mapFaktury(readDbfFile(path.join(firmaDir, "FAKPRI.DBF"), label), label);
}

/** Data jedné firmy podle jejího ID (znovu použitelné v zápisu, např. pro opětovné načtení FAKPRI). */
export function readFirmaData(kaktusDir: string, firmaId: string): FirmaData {
  if (!FIRMA_ID_RE.test(firmaId)) throw new VstupniChyba(`Neplatné ID firmy "${firmaId}" (očekáváno 4 číslice).`);
  const firma = readFirmy(kaktusDir).find((f) => f.id === firmaId && !f.smazano);
  if (!firma) throw new VstupniChyba(`Firma ${firmaId} není ve FIRMY.DBF.`);
  const dir = resolveFirmaDir(kaktusDir, firma);
  return { firma, dodavatele: readDodavatele(dir, firma.id), faktury: readFaktury(dir, firma.id) };
}

/** Všechny firmy s dodavateli a přijatými fakturami (částky v haléřích). */
export function readAll(kaktusDir: string): KaktusData {
  const firmy: FirmaNactena[] = readFirmy(kaktusDir).map((firma) => {
    if (firma.smazano) return { ...firma, dodavatele: null, faktury: null };
    const dir = resolveFirmaDir(kaktusDir, firma);
    return { ...firma, dodavatele: readDodavatele(dir, firma.id), faktury: readFaktury(dir, firma.id) };
  });
  return { firmy };
}

export function toFakturaVystup(f: FakturaPrijata): FakturaVystup {
  const out = { ...f, kurz: f.kurz === null ? null : f.kurz.toFixed(4) } as unknown as FakturaVystup;
  for (const k of CASTKA_POLE) {
    const v = f[k];
    out[k] = v === null ? null : centsToDecimal(v);
  }
  return out;
}

/** Výstup příkazu `cist` (JSON pro TAXY): částky jako desetinné řetězce, viz `FakturaVystup`. */
export function toVystup(data: KaktusData): KaktusVystup {
  return {
    format: 2,
    firmy: data.firmy.map((f) => ({ ...f, faktury: f.faktury === null ? null : f.faktury.map(toFakturaVystup) })),
  };
}
