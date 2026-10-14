#!/usr/bin/env node
// Kaktus konektor pro TAXY – příkazová řádka.
//   node dist/cli.js cist  --kaktus ./kaktus --out out/kaktus-data.json
//   node dist/cli.js zapis --kaktus ./kaktus --klienti taxy/klienti.json \
//                          --doklady taxy/doklady-k-zapisu.json --out out/zapis-report.json [--dry-run]
// Exit kódy: 0 = hotovo, 1 = chybný vstup/konfigurace, 2 = nedokončeno (bezpečné spustit znovu).

import * as fs from "node:fs";
import * as path from "node:path";
import { PouzitiChyba, VstupniChyba } from "./errors";
import { writeJsonAtomic } from "./fs-util";
import { readAll } from "./kaktus/read";
import { loadDoklady, loadKlienti } from "./taxy/input";
import { zapis } from "./write";
import type { ZapisReport } from "./write";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: Io = {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
};

const USAGE = [
  "Použití:",
  "  cist  --kaktus <složka> --out <soubor.json>",
  "  zapis --kaktus <složka> --klienti <klienti.json> --doklady <doklady.json> --out <report.json> [--dry-run]",
].join("\n");

interface CommandSpec {
  /** Volby s hodnotou (povinné). */
  values: readonly string[];
  /** Přepínače bez hodnoty (nepovinné). */
  flags: readonly string[];
}

const COMMANDS: Record<string, CommandSpec> = {
  cist: { values: ["kaktus", "out"], flags: [] },
  zapis: { values: ["kaktus", "klienti", "doklady", "out"], flags: ["dry-run"] },
};

export interface ParsedArgs {
  command: string;
  options: Map<string, string>;
  flags: Set<string>;
}

/** Přísné zpracování argumentů: neznámá volba, duplicita, chybějící hodnota či povinná volba = VstupniChyba. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (command === undefined) throw new PouzitiChyba("Chybí příkaz (cist nebo zapis).");
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    throw new PouzitiChyba(`Neznámý příkaz "${command}" (podporováno: cist, zapis).`);
  }
  const spec = COMMANDS[command] as CommandSpec;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) throw new PouzitiChyba(`Neočekávaný argument "${arg}".`);
    const name = arg.slice(2);
    if (spec.flags.includes(name)) {
      if (flags.has(name)) throw new PouzitiChyba(`Přepínač --${name} je uveden vícekrát.`);
      flags.add(name);
    } else if (spec.values.includes(name)) {
      if (options.has(name)) throw new PouzitiChyba(`Volba --${name} je uvedena vícekrát.`);
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new PouzitiChyba(`Volba --${name} vyžaduje hodnotu.`);
      }
      options.set(name, value);
      i++;
    } else {
      throw new PouzitiChyba(`Neznámá volba "${arg}" pro příkaz ${command}.`);
    }
  }
  for (const name of spec.values) {
    if (!options.has(name)) throw new PouzitiChyba(`Chybí povinná volba --${name}.`);
  }
  return { command, options, flags };
}

function requireDirectory(dir: string): void {
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    // nenalezeno / nedostupné → hláška níže
  }
  if (!isDir) throw new VstupniChyba(`Složka Kaktusu "${dir}" nebyla nalezena.`);
}

function runCist(args: ParsedArgs, io: Io): number {
  const kaktusDir = path.resolve(args.options.get("kaktus") as string);
  const outFile = path.resolve(args.options.get("out") as string);
  requireDirectory(kaktusDir);
  const data = readAll(kaktusDir);
  writeJsonAtomic(outFile, data);
  const dodavatelu = data.firmy.reduce((n, f) => n + (f.dodavatele?.length ?? 0), 0);
  const faktur = data.firmy.reduce((n, f) => n + (f.faktury?.length ?? 0), 0);
  io.out(`Načteno: ${data.firmy.length} firem, ${dodavatelu} dodavatelů, ${faktur} přijatých faktur. Výstup: ${outFile}`);
  return 0;
}

/** Krátké české shrnutí běhu (bez dat dokladů). */
export function shrnuti(report: ZapisReport): string[] {
  const p = report.souhrn.pocty;
  const lines: string[] = [];
  if (report.rezim === "dry-run") {
    lines.push(
      `Zkušební běh (nic se nezapsalo): ${report.souhrn.celkem} dokladů, k zápisu ${p.k_zapisu}, již zapsáno ${p.jiz_zapsano}, odmítnuto ${p.odmitnuto}.`,
    );
  } else {
    lines.push(
      `Zpracováno ${report.souhrn.celkem} dokladů: zapsáno ${p.zapsano}, již zapsáno ${p.jiz_zapsano}, odmítnuto ${p.odmitnuto}, chyba Kaktusu ${p.chyba_kaktusu}, neprovedeno ${p.neprovedeno}.`,
    );
  }
  for (const [firma, f] of Object.entries(report.souhrn.firmy)) {
    if (f.preruseno !== undefined) lines.push(`Firma ${firma} přerušena: ${f.preruseno}`);
  }
  if (p.neprovedeno > 0) lines.push("Část dokladů nebyla zpracována; spuštění lze bezpečně zopakovat.");
  return lines;
}

async function runZapis(args: ParsedArgs, io: Io): Promise<number> {
  const kaktusDir = path.resolve(args.options.get("kaktus") as string);
  const outFile = path.resolve(args.options.get("out") as string);
  requireDirectory(kaktusDir);
  const klienti = loadKlienti(path.resolve(args.options.get("klienti") as string));
  const doklady = loadDoklady(path.resolve(args.options.get("doklady") as string));
  const report = await zapis({ kaktusDir, klienti, doklady, dryRun: args.flags.has("dry-run") });
  writeJsonAtomic(outFile, report);
  for (const l of shrnuti(report)) io.out(l);
  io.out(`Report: ${outFile}`);
  return report.souhrn.pocty.neprovedeno > 0 ? 2 : 0;
}

/** Spustí CLI, vrací exit kód (nevolá process.exit, aby šlo testovat). */
export async function main(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      io.out(USAGE);
      return 0;
    }
    const args = parseArgs(argv);
    return args.command === "cist" ? runCist(args, io) : await runZapis(args, io);
  } catch (e) {
    if (e instanceof VstupniChyba) {
      io.err(e.message);
      if (e instanceof PouzitiChyba) io.err(USAGE);
      return 1;
    }
    io.err(`Neočekávaná chyba: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
