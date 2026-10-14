// Společné pomocné funkce testů. Integrační testy pracují výhradně nad kopií složky `kaktus/`
// v adresáři z `fs.mkdtemp`; originál (`./kaktus`) se nikdy nemění.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { readFirmaData } from "../src/kaktus/read";
import type { FakturaPrijata, FirmaData } from "../src/kaktus/read";
import { loadDoklady, loadKlienti } from "../src/taxy/input";
import type { Klient } from "../src/taxy/input";
import type { ZapisDoklad, ZapisReport } from "../src/write";

/** Kořen repozitáře (testy běží z build-test/test). */
export const ROOT = path.resolve(__dirname, "..", "..");
export const ORIG_KAKTUS = path.join(ROOT, "kaktus");

export interface Sandbox {
  root: string;
  kaktusDir: string;
  /** Vlastní tmp kořen pro dočasné soubory dávek (kontrola, že se uklidí). */
  tmpRoot: string;
  cleanup(): void;
}

/** Hash originálu (jen soubory DATA), aby šlo ověřit, že ho testy nezměnily. */
export function hashTree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.readFileSync(p).toString("base64")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

/** Čistá kopie celého `kaktus/` (včetně simulátoru) + `obnovit`, takže data jsou výchozí. */
export function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taxy-test-"));
  const kaktusDir = path.join(root, "kaktus");
  fs.cpSync(ORIG_KAKTUS, kaktusDir, { recursive: true });
  execFileSync(process.execPath, [path.join(kaktusDir, "kaktus.cjs"), "obnovit"], { stdio: "pipe" });
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(tmpRoot);
  return {
    root,
    kaktusDir,
    tmpRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Spustí příkaz simulátoru z kopie (zamknout/odemknout). */
export function simulator(sb: Sandbox, ...args: string[]): void {
  execFileSync(process.execPath, [path.join(sb.kaktusDir, "kaktus.cjs"), ...args], { stdio: "pipe" });
}

export function lockFile(sb: Sandbox, firma: string): string {
  return path.join(sb.kaktusDir, "DATA", firma, "FIRMA.LCK");
}

export function fakpriBytes(sb: Sandbox, firma: string): Buffer {
  return fs.readFileSync(path.join(sb.kaktusDir, "DATA", firma, "FAKPRI.DBF"));
}

export function adresarBytes(sb: Sandbox, firma: string): Buffer {
  return fs.readFileSync(path.join(sb.kaktusDir, "DATA", firma, "ADRESAR.DBF"));
}

export function data(sb: Sandbox, firma: string): FirmaData {
  return readFirmaData(sb.kaktusDir, firma);
}

/** Nesmazané doklady se značkou `TAXY:<id>` (celé ID, ne předpona). */
export function byMarker(f: FirmaData | FakturaPrijata[], id: string): FakturaPrijata[] {
  const list = Array.isArray(f) ? f : f.faktury;
  const re = new RegExp(`(^|\s)TAXY:${id}(\s|$)`);
  return list.filter((x) => !x.smazano && re.test(x.poznamka));
}

export function realKlienti(): Klient[] {
  return loadKlienti(path.join(ROOT, "taxy", "klienti.json"));
}

export function realDoklady(): unknown[] {
  return loadDoklady(path.join(ROOT, "taxy", "doklady-k-zapisu.json"));
}

export function realDoklad(id: string): Record<string, unknown> {
  const d = realDoklady().find((x) => (x as { id?: string }).id === id);
  if (d === undefined) throw new Error(`Doklad ${id} není v taxy/doklady-k-zapisu.json.`);
  return JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
}

export function radek(report: ZapisReport, id: string): ZapisDoklad {
  const r = report.doklady.find((x) => x.id === id);
  if (r === undefined) throw new Error(`V reportu chybí doklad ${id}.`);
  return r;
}

/** Syntetický doklad (klient 4172 → firma 0001), každý volající přepíše, co potřebuje. */
export function mkDoklad(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    klientId: 4172,
    typ: "faktura_prijata",
    stav: "schvaleno",
    cisloDokladu: `T-${id}`,
    variabilniSymbol: "123",
    dodavatel: {
      nazev: `Testovací dodavatel ${id}`,
      ico: "90999001",
      dic: "CZ90999001",
      ulice: "Ulice 1",
      mesto: "Praha",
      psc: "11000",
      stat: "CZ",
    },
    odberatel: { nazev: "Truhlářství Dvořák s.r.o.", ico: "90412761" },
    datumVystaveni: "2026-10-01",
    duzp: "2026-10-01",
    datumSplatnosti: "2026-10-15",
    rozpisDph: [{ sazba: 21, zaklad: 100, dph: 21 }],
    celkem: 121,
    mena: "CZK",
    kurz: null,
    popis: "Test",
    ...over,
  };
}

/** Obsah adresáře (pro kontrolu, že po běhu nezůstaly dočasné soubory). */
export function listDir(dir: string): string[] {
  return fs.readdirSync(dir);
}
