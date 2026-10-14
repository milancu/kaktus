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

function runZapis(_args: ParsedArgs, io: Io): number {
  io.err("Příkaz zapis zatím není implementován.");
  return 1;
}

/** Spustí CLI, vrací exit kód (nevolá process.exit, aby šlo testovat). */
export function main(argv: readonly string[], io: Io = defaultIo): number {
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      io.out(USAGE);
      return 0;
    }
    const args = parseArgs(argv);
    return args.command === "cist" ? runCist(args, io) : runZapis(args, io);
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
  process.exitCode = main(process.argv.slice(2));
}
