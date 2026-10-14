// Spuštění importu Kaktusu a parsování jeho odpovědi.
//
//  - Import se spouští jen přes `execFile(process.execPath, [kaktus.cjs, "import", dávka, odpověď])`:
//    pole argumentů, `shell: false`, timeout, žádné skládání příkazu ze stringu.
//  - Každá dávka dostane nový dočasný adresář (`fs.mkdtemp`) a odpověď se píše do nového souboru
//    v něm; starou odpověď nelze přečíst, adresář se po zpracování smaže.
//  - Odpověď je jen nápověda (pravdu má DBF); parser je přesto striktní a minimální:
//    `<!DOCTYPE`, `<!ENTITY`, komentáře, CDATA a processing instructions se odmítají.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { decodeWin1250, isXmlChar } from "../codec";
import { VstupniChyba } from "../errors";
import { FIRMA_ID_RE } from "./read";

export const DEFAULT_IMPORT_TIMEOUT_MS = 60_000;
export const MAX_ODPOVED_BYTES = 1024 * 1024;
const MAX_ZPRAVA = 300;

// ---------------------------------------------------------------------------
// Parser odpovědi (čisté funkce)
// ---------------------------------------------------------------------------

/** Odpověď Kaktusu k jednomu dokladu dávky. */
export interface OdpovedDoklad {
  /** Pořadí v dávce od 1. */
  poradi: number;
  stav: "OK" | "CHYBA";
  /** Číslo dokladu v Kaktusu (jen u `OK`). */
  doklad?: string;
  /** Kód chyby `Ennn` (jen u `CHYBA`). */
  kod?: string;
  zprava?: string;
}

export interface OdpovedKaktusu {
  firma: string;
  /** Klíč = `poradi`. Chybějící klíč = Kaktus k dokladu nic neřekl. */
  doklady: Map<number, OdpovedDoklad>;
}

/** Odpověď Kaktusu nelze použít (neplatný tvar, zakázaná konstrukce, nesedící `poradi`…). */
export class OdpovedChyba extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OdpovedChyba";
  }
}

export interface OdpovedOcekavani {
  /** ID firmy, pro kterou byla dávka odeslána. */
  firma: string;
  /** Počet dokladů v odeslané dávce (`poradi` musí být 1..pocet). */
  pocet: number;
}

type Attrs = Map<string, string>;

interface Tag {
  kind: "open" | "close" | "empty";
  name: string;
  attrs: Attrs;
  next: number;
}

const XML_DECL_RE = /^<\?xml(\s[^?>]*)?\?>/;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_.-]*/y;
const WS_RE = /\s*/y;
const ATTR_RE = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

function skipWs(text: string, pos: number): number {
  WS_RE.lastIndex = pos;
  WS_RE.exec(text);
  return WS_RE.lastIndex;
}

/** Dekóduje hodnoty atributu; povoleny jen pět základních entit a číselné odkazy na platné znaky XML. */
export function decodeEntities(value: string): string {
  return value.replace(/&([^;&\s]*);?/g, (all, body: string) => {
    if (!all.endsWith(";")) throw new OdpovedChyba("Neplatný znak & v odpovědi.");
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: break;
    }
    let cp = NaN;
    if (/^#x[0-9A-Fa-f]{1,6}$/.test(body)) cp = parseInt(body.slice(2), 16);
    else if (/^#\d{1,7}$/.test(body)) cp = parseInt(body.slice(1), 10);
    else throw new OdpovedChyba("Neznámá entita v odpovědi.");
    if (!Number.isInteger(cp) || cp > 0x10ffff || !isXmlChar(cp)) {
      throw new OdpovedChyba("Neplatný číselný odkaz na znak v odpovědi.");
    }
    return String.fromCodePoint(cp);
  });
}

function readTag(text: string, pos: number): Tag {
  if (text[pos] !== "<") throw new OdpovedChyba("Odpověď: očekáván element.");
  let p = pos + 1;
  let closing = false;
  if (text[p] === "/") {
    closing = true;
    p++;
  }
  NAME_RE.lastIndex = p;
  const m = NAME_RE.exec(text);
  if (m === null) throw new OdpovedChyba("Odpověď: neplatný název elementu.");
  const name = m[0];
  p = NAME_RE.lastIndex;
  const attrs: Attrs = new Map();
  if (!closing) {
    for (;;) {
      ATTR_RE.lastIndex = p;
      const a = ATTR_RE.exec(text);
      if (a === null) break;
      const key = a[1] as string;
      if (attrs.has(key)) throw new OdpovedChyba(`Odpověď: atribut ${key} je uveden dvakrát.`);
      attrs.set(key, decodeEntities((a[2] ?? a[3]) as string));
      p = ATTR_RE.lastIndex;
    }
  }
  p = skipWs(text, p);
  if (closing) {
    if (text[p] !== ">") throw new OdpovedChyba("Odpověď: neplatná koncová značka.");
    return { kind: "close", name, attrs, next: p + 1 };
  }
  if (text.startsWith("/>", p)) return { kind: "empty", name, attrs, next: p + 2 };
  if (text[p] === ">") return { kind: "open", name, attrs, next: p + 1 };
  throw new OdpovedChyba("Odpověď: neplatná značka (atribut musí být v uvozovkách).");
}

function decodeBody(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 200)).toString("latin1");
  const decl = XML_DECL_RE.exec(head);
  const enc = decl === null ? null : /\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(decl[0]);
  const name = enc === null ? "windows-1250" : (enc[1] as string).toLowerCase();
  if (name === "windows-1250" || name === "cp1250") return decodeWin1250(bytes);
  if (name === "utf-8" || name === "utf8") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new OdpovedChyba("Odpověď není platné UTF-8.");
    }
  }
  throw new OdpovedChyba("Odpověď má nepodporované kódování.");
}

function cleanMessage(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    out += cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || !isXmlChar(cp) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_ZPRAVA ? `${out.slice(0, MAX_ZPRAVA)}…` : out;
}

function parseDokladElement(attrs: Attrs, pocet: number): OdpovedDoklad {
  const poradiText = attrs.get("poradi");
  if (poradiText === undefined || !/^\d{1,4}$/.test(poradiText)) throw new OdpovedChyba("Odpověď: chybí nebo je neplatné poradi.");
  const poradi = Number(poradiText);
  if (poradi < 1 || poradi > pocet) throw new OdpovedChyba(`Odpověď: poradi ${poradi} je mimo rozsah dávky (1–${pocet}).`);
  const stav = attrs.get("stav");
  if (stav === "OK") {
    const doklad = attrs.get("doklad");
    if (doklad === undefined || !/^[A-Za-z0-9_-]{1,10}$/.test(doklad)) {
      throw new OdpovedChyba(`Odpověď: doklad ${poradi} nemá platné číslo dokladu.`);
    }
    return { poradi, stav, doklad };
  }
  if (stav === "CHYBA") {
    const kod = attrs.get("kod");
    if (kod === undefined || !/^E\d{3}$/.test(kod)) throw new OdpovedChyba(`Odpověď: doklad ${poradi} nemá platný kód chyby.`);
    return { poradi, stav, kod, zprava: cleanMessage(attrs.get("zprava") ?? "") };
  }
  throw new OdpovedChyba(`Odpověď: doklad ${poradi} má neznámý stav.`);
}

/**
 * Striktní minimální parser odpovědi `<KaktusOdpoved>`. Kódování podle deklarace (výchozí
 * a to, které píše simulátor, je Win-1250). Odmítá DOCTYPE/ENTITY, komentáře, CDATA, processing
 * instructions mimo úvodní XML deklaraci, neznámé elementy a text mimo elementy. Neznámé atributy
 * ignoruje. `poradi` musí být v rozsahu dávky a bez duplicit; chybějící `Doklad` není chyba
 * (položka zůstane neověřená a rozhodne ověření podle DBF).
 */
export function parseOdpoved(bytes: Uint8Array, ocekavani: OdpovedOcekavani): OdpovedKaktusu {
  if (bytes.length > MAX_ODPOVED_BYTES) throw new OdpovedChyba("Odpověď je příliš velká.");
  const text = decodeBody(bytes);
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) throw new OdpovedChyba("Odpověď obsahuje zakázanou konstrukci DOCTYPE/ENTITY.");
  let pos = 0;
  const decl = XML_DECL_RE.exec(text);
  if (decl !== null) pos = decl[0].length;
  pos = skipWs(text, pos);
  if (text.startsWith("<!", pos) || text.startsWith("<?", pos)) {
    throw new OdpovedChyba("Odpověď obsahuje nepovolenou konstrukci (komentář, CDATA nebo processing instruction).");
  }
  const root = readTag(text, pos);
  if (root.kind === "close" || root.name !== "KaktusOdpoved") throw new OdpovedChyba("Kořenový element musí být KaktusOdpoved.");
  const firma = root.attrs.get("firma");
  if (firma === undefined || !FIRMA_ID_RE.test(firma)) throw new OdpovedChyba("Odpověď nemá platné ID firmy.");
  if (firma !== ocekavani.firma) throw new OdpovedChyba("Odpověď se týká jiné firmy, než do které se importovalo.");
  const doklady = new Map<number, OdpovedDoklad>();
  pos = root.next;
  if (root.kind === "open") {
    for (;;) {
      pos = skipWs(text, pos);
      if (pos >= text.length) throw new OdpovedChyba("Odpověď je useknutá.");
      if (text.startsWith("<!", pos) || text.startsWith("<?", pos)) {
        throw new OdpovedChyba("Odpověď obsahuje nepovolenou konstrukci (komentář, CDATA nebo processing instruction).");
      }
      const tag = readTag(text, pos);
      pos = tag.next;
      if (tag.kind === "close") {
        if (tag.name !== "KaktusOdpoved") throw new OdpovedChyba("Odpověď: nesedí koncová značka.");
        break;
      }
      if (tag.name !== "Doklad") throw new OdpovedChyba("Odpověď: neočekávaný element.");
      if (tag.kind === "open") {
        const close = readTag(text, skipWs(text, pos));
        if (close.kind !== "close" || close.name !== "Doklad") throw new OdpovedChyba("Odpověď: element Doklad nesmí mít obsah.");
        pos = close.next;
      }
      const d = parseDokladElement(tag.attrs, ocekavani.pocet);
      if (doklady.has(d.poradi)) throw new OdpovedChyba(`Odpověď: poradi ${d.poradi} je uvedeno dvakrát.`);
      doklady.set(d.poradi, d);
    }
  }
  if (skipWs(text, pos) !== text.length) throw new OdpovedChyba("Odpověď: za kořenovým elementem je další obsah.");
  return { firma, doklady };
}

// ---------------------------------------------------------------------------
// Spuštění importu
// ---------------------------------------------------------------------------

export interface RunnerVstup {
  kaktusDir: string;
  davkaPath: string;
  odpovedPath: string;
  timeoutMs: number;
}

export interface RunnerVysledek {
  /** Exit kód procesu; null, pokud proces neskončil normálně. */
  exitCode: number | null;
  timedOut?: boolean;
}

/** Spouštěč importu. V testech jde nahradit (simulace pádu); výjimka z něj = pád importu. */
export type ImportRunner = (vstup: RunnerVstup) => Promise<RunnerVysledek>;

export type ImportStav = "zpracovano" | "davka_necitelna" | "firma_zamcena" | "firma_neexistuje" | "pad";

export interface ImportVysledek {
  stav: ImportStav;
  exitCode: number | null;
  /** Rozparsovaná odpověď, pokud existovala a byla platná. Je to jen nápověda, pravdu má DBF. */
  odpoved: OdpovedKaktusu | null;
  /** Proč odpověď nelze použít (nečitelná/neplatná); chybí-li soubor úplně, nevyplněno. */
  odpovedChyba?: string;
  /** Stručný technický detail (bez dat dokladů). */
  detail?: string;
}

/** Cesta ke `kaktus.cjs` ve složce Kaktusu; musí existovat jako soubor. */
export function resolveKaktusScript(kaktusDir: string): string {
  const script = path.resolve(kaktusDir, "kaktus.cjs");
  let ok = false;
  try {
    ok = fs.statSync(script).isFile();
  } catch {
    // hláška níže
  }
  if (!ok) throw new VstupniChyba(`Ve složce Kaktusu "${kaktusDir}" chybí soubor kaktus.cjs.`);
  return script;
}

/** Mapování exit kódu importu (0–4 podle simulátoru) na stav. */
export function mapExitCode(exitCode: number | null, timedOut: boolean): { stav: ImportStav; detail?: string } {
  if (timedOut) return { stav: "pad", detail: "Import překročil časový limit." };
  switch (exitCode) {
    case 0: return { stav: "zpracovano" };
    case 2: return { stav: "davka_necitelna" };
    case 3: return { stav: "firma_zamcena" };
    case 4: return { stav: "firma_neexistuje" };
    default: return { stav: "pad", detail: exitCode === null ? "Import skončil neočekávaně." : `Import skončil s kódem ${exitCode}.` };
  }
}

/** Výchozí spouštěč: `execFile(process.execPath, [kaktus.cjs, "import", dávka, odpověď])`, bez shellu. */
export const defaultRunner: ImportRunner = (vstup) => {
  const script = resolveKaktusScript(vstup.kaktusDir);
  return new Promise<RunnerVysledek>((resolve) => {
    execFile(
      process.execPath,
      [script, "import", vstup.davkaPath, vstup.odpovedPath],
      { shell: false, timeout: vstup.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, cwd: path.dirname(script) },
      (error) => {
        if (error === null) {
          resolve({ exitCode: 0 });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (typeof e.code === "number") resolve({ exitCode: e.code });
        else resolve({ exitCode: null, timedOut: e.killed === true || (e.signal ?? null) !== null });
      },
    );
  });
};

function readOdpoved(odpovedPath: string, ocekavani: OdpovedOcekavani): Pick<ImportVysledek, "odpoved" | "odpovedChyba"> {
  let bytes: Buffer;
  try {
    const st = fs.statSync(odpovedPath);
    if (!st.isFile()) return { odpoved: null, odpovedChyba: "Odpověď není soubor." };
    if (st.size > MAX_ODPOVED_BYTES) return { odpoved: null, odpovedChyba: "Odpověď je příliš velká." };
    bytes = fs.readFileSync(odpovedPath);
  } catch {
    return { odpoved: null };
  }
  try {
    return { odpoved: parseOdpoved(bytes, ocekavani) };
  } catch (e) {
    if (e instanceof OdpovedChyba) return { odpoved: null, odpovedChyba: e.message };
    throw e;
  }
}

export interface RunImportOpts extends OdpovedOcekavani {
  timeoutMs?: number;
  runner?: ImportRunner;
}

/**
 * Spustí import dávky a zpracuje výsledek. Nikdy nevyhazuje kvůli pádu importu (včetně výjimky
 * ze spouštěče) – pád je výsledek `pad`. Odpověď se čte, kdykoli soubor existuje (i po pádu);
 * volající musí zajistit, že `odpovedPath` je v čerstvém adresáři.
 */
export async function runImport(
  kaktusDir: string, davkaPath: string, odpovedPath: string, opts: RunImportOpts,
): Promise<ImportVysledek> {
  const runner = opts.runner ?? defaultRunner;
  let exitCode: number | null = null;
  let timedOut = false;
  let thrown = false;
  try {
    const r = await runner({ kaktusDir, davkaPath, odpovedPath, timeoutMs: opts.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS });
    exitCode = r.exitCode;
    timedOut = r.timedOut === true;
  } catch {
    thrown = true;
  }
  const mapped = thrown ? { stav: "pad" as ImportStav, detail: "Import skončil chybou." } : mapExitCode(exitCode, timedOut);
  return { ...mapped, exitCode, ...readOdpoved(odpovedPath, opts) };
}

export interface ImportDavkyOpts extends RunImportOpts {
  /** Kořen pro dočasné adresáře (výchozí `os.tmpdir()`). */
  tmpRoot?: string;
}

/**
 * Zapíše dávku do nového dočasného adresáře (`fs.mkdtemp`), spustí import s odpovědí v novém
 * souboru téhož adresáře a adresář se pokusí smazat (best-effort, chyba úklidu se ignoruje).
 */
export async function importDavka(kaktusDir: string, xml: Buffer, opts: ImportDavkyOpts): Promise<ImportVysledek> {
  const dir = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "taxy-kaktus-"));
  try {
    const davkaPath = path.join(dir, "davka.xml");
    const odpovedPath = path.join(dir, "odpoved.xml");
    fs.writeFileSync(davkaPath, xml, { flag: "wx", mode: 0o600 });
    return await runImport(kaktusDir, davkaPath, odpovedPath, opts);
  } finally {
    // Úklid je best-effort: selhání (EBUSY/EPERM, antivir…) nesmí přebít výsledek importu,
    // který už proběhl a jehož výsledek se ověřuje podle DBF.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // adresář zůstane v tmp; neovlivňuje data Kaktusu ani výsledek
    }
  }
}
