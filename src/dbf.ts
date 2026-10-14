// Čtení dBase III (.DBF) – hlavička, deskriptory polí, záznamy včetně příznaku smazání.
// Jen čtení; do DBF nikdy nezapisujeme (zápis jde výhradně přes XML import Kaktusu).

import * as fs from "node:fs";
import { decodeCp852 } from "./codec";
import { VstupniChyba } from "./errors";

/** Hodnota pole: C → text, N → text čísla (nebo null, je-li prázdné), D → ISO datum, L → boolean. */
export type DbfValue = string | boolean | null;

export type DbfFieldType = "C" | "N" | "D" | "L";

export interface DbfField {
  name: string;
  type: DbfFieldType;
  length: number;
  decimals: number;
}

export interface DbfRecord {
  /** Pořadí záznamu v souboru (od 0). */
  index: number;
  /** Záznam je v DBF označen jako smazaný (příznak `*`). */
  deleted: boolean;
  values: ReadonlyMap<string, DbfValue>;
}

export interface DbfTable {
  fields: DbfField[];
  records: DbfRecord[];
}

/** Kódová stránka CP852 (LDID 100), jediná, kterou Kaktus používá. */
const LDID_CP852 = 100;
/** Horní mez velikosti souboru, proti vyčerpání paměti u poškozeného/podstrčeného souboru. */
export const MAX_DBF_BYTES = 256 * 1024 * 1024;

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,10}$/;
const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

function chyba(label: string, text: string): VstupniChyba {
  return new VstupniChyba(`Soubor ${label} není platné DBF: ${text}.`);
}

function parseFields(buf: Uint8Array, headerLen: number, label: string): DbfField[] {
  const fields: DbfField[] = [];
  const seen = new Set<string>();
  let offset = 32;
  for (;;) {
    if (offset >= headerLen) throw chyba(label, "chybí ukončení seznamu polí");
    if (buf[offset] === 0x0d) break;
    if (offset + 32 > headerLen) throw chyba(label, "nekompletní deskriptor pole");
    let name = "";
    for (let i = 0; i < 11 && buf[offset + i] !== 0; i++) {
      name += String.fromCharCode(buf[offset + i] as number);
    }
    if (!FIELD_NAME_RE.test(name)) throw chyba(label, "neplatný název pole");
    if (seen.has(name)) throw chyba(label, `duplicitní pole ${name}`);
    seen.add(name);
    const type = String.fromCharCode(buf[offset + 11] as number);
    if (type !== "C" && type !== "N" && type !== "D" && type !== "L") {
      throw chyba(label, `nepodporovaný typ pole ${name} (${JSON.stringify(type)})`);
    }
    const length = buf[offset + 16] as number;
    const decimals = buf[offset + 17] as number;
    if (length === 0) throw chyba(label, `pole ${name} má nulovou délku`);
    fields.push({ name, type, length, decimals });
    offset += 32;
  }
  if (fields.length === 0) throw chyba(label, "žádná pole");
  return fields;
}

function trimRightSpacesAndNul(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === 0x20 || s.charCodeAt(end - 1) === 0)) end--;
  return s.slice(0, end);
}

function parseValue(field: DbfField, raw: Uint8Array, label: string, index: number): DbfValue {
  const where = `záznam ${index + 1}, pole ${field.name}`;
  const text = decodeCp852(raw);
  switch (field.type) {
    case "C":
      return trimRightSpacesAndNul(text);
    case "N": {
      const t = text.trim();
      return t === "" ? null : t;
    }
    case "D": {
      const t = text.trim();
      if (t === "") return null;
      const m = DATE_RE.exec(t);
      if (!m) throw chyba(label, `neplatné datum (${where})`);
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
        throw chyba(label, `neexistující datum (${where})`);
      }
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
    case "L": {
      const t = text.trim();
      if (t === "" || t === "?") return null;
      if (/^[TtYy]$/.test(t)) return true;
      if (/^[FfNn]$/.test(t)) return false;
      throw chyba(label, `neplatná logická hodnota (${where})`);
    }
  }
}

/**
 * Rozparsuje obsah DBF souboru. Čistá funkce bez I/O; `label` je jen pro hlášky.
 * Je přísná: při nesrovnalosti v hlavičce nebo záznamech vyhodí VstupniChyba.
 */
export function parseDbf(buf: Uint8Array, label: string): DbfTable {
  if (buf.length < 33) throw chyba(label, "soubor je příliš krátký");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== 0x03) throw chyba(label, `nepodporovaná verze (0x${(buf[0] as number).toString(16)})`);
  const ldid = buf[29] as number;
  if (ldid !== LDID_CP852) {
    throw chyba(label, `nepodporované kódování (LDID ${ldid}, očekáváno ${LDID_CP852} = CP852)`);
  }
  const count = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recLen = dv.getUint16(10, true);
  if (headerLen < 33 || headerLen > buf.length) throw chyba(label, "neplatná délka hlavičky");

  const fields = parseFields(buf, headerLen, label);
  const sum = fields.reduce((acc, f) => acc + f.length, 0);
  if (recLen !== sum + 1) throw chyba(label, "délka záznamu neodpovídá polím");
  if (headerLen + count * recLen > buf.length) throw chyba(label, "soubor je useknutý (méně záznamů než v hlavičce)");

  const records: DbfRecord[] = [];
  for (let i = 0; i < count; i++) {
    const start = headerLen + i * recLen;
    const flag = buf[start];
    if (flag !== 0x20 && flag !== 0x2a) throw chyba(label, `neplatný příznak záznamu ${i + 1}`);
    const values = new Map<string, DbfValue>();
    let pos = start + 1;
    for (const f of fields) {
      values.set(f.name, parseValue(f, buf.subarray(pos, pos + f.length), label, i));
      pos += f.length;
    }
    records.push({ index: i, deleted: flag === 0x2a, values });
  }
  return { fields, records };
}

/** Načte a rozparsuje DBF ze souboru. */
export function readDbfFile(file: string, label: string): DbfTable {
  let buf: Buffer;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new VstupniChyba(`${label} není soubor.`);
    if (st.size > MAX_DBF_BYTES) throw new VstupniChyba(`Soubor ${label} je příliš velký.`);
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e instanceof VstupniChyba) throw e;
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") throw new VstupniChyba(`Soubor ${label} nebyl nalezen.`);
    throw new VstupniChyba(`Soubor ${label} nelze přečíst (${code ?? "neznámá chyba"}).`);
  }
  return parseDbf(buf, label);
}
