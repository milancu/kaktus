#!/usr/bin/env node
"use strict";
// Kaktus konektor pro TAXY – příkazová řádka.
//   node dist/cli.js cist  --kaktus ./kaktus --out out/kaktus-data.json
//   node dist/cli.js zapis --kaktus ./kaktus --klienti taxy/klienti.json \
//                          --doklady taxy/doklady-k-zapisu.json --out out/zapis-report.json [--dry-run]
// Exit kódy: 0 = hotovo, 1 = chybný vstup/konfigurace, 2 = nedokončeno (bezpečné spustit znovu).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
exports.main = main;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const errors_1 = require("./errors");
const fs_util_1 = require("./fs-util");
const read_1 = require("./kaktus/read");
const defaultIo = {
    out: (t) => console.log(t),
    err: (t) => console.error(t),
};
const USAGE = [
    "Použití:",
    "  cist  --kaktus <složka> --out <soubor.json>",
    "  zapis --kaktus <složka> --klienti <klienti.json> --doklady <doklady.json> --out <report.json> [--dry-run]",
].join("\n");
const COMMANDS = {
    cist: { values: ["kaktus", "out"], flags: [] },
    zapis: { values: ["kaktus", "klienti", "doklady", "out"], flags: ["dry-run"] },
};
/** Přísné zpracování argumentů: neznámá volba, duplicita, chybějící hodnota či povinná volba = VstupniChyba. */
function parseArgs(argv) {
    const command = argv[0];
    if (command === undefined)
        throw new errors_1.PouzitiChyba("Chybí příkaz (cist nebo zapis).");
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
        throw new errors_1.PouzitiChyba(`Neznámý příkaz "${command}" (podporováno: cist, zapis).`);
    }
    const spec = COMMANDS[command];
    const options = new Map();
    const flags = new Set();
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--"))
            throw new errors_1.PouzitiChyba(`Neočekávaný argument "${arg}".`);
        const name = arg.slice(2);
        if (spec.flags.includes(name)) {
            if (flags.has(name))
                throw new errors_1.PouzitiChyba(`Přepínač --${name} je uveden vícekrát.`);
            flags.add(name);
        }
        else if (spec.values.includes(name)) {
            if (options.has(name))
                throw new errors_1.PouzitiChyba(`Volba --${name} je uvedena vícekrát.`);
            const value = argv[i + 1];
            if (value === undefined || value === "" || value.startsWith("--")) {
                throw new errors_1.PouzitiChyba(`Volba --${name} vyžaduje hodnotu.`);
            }
            options.set(name, value);
            i++;
        }
        else {
            throw new errors_1.PouzitiChyba(`Neznámá volba "${arg}" pro příkaz ${command}.`);
        }
    }
    for (const name of spec.values) {
        if (!options.has(name))
            throw new errors_1.PouzitiChyba(`Chybí povinná volba --${name}.`);
    }
    return { command, options, flags };
}
function requireDirectory(dir) {
    let isDir = false;
    try {
        isDir = fs.statSync(dir).isDirectory();
    }
    catch {
        // nenalezeno / nedostupné → hláška níže
    }
    if (!isDir)
        throw new errors_1.VstupniChyba(`Složka Kaktusu "${dir}" nebyla nalezena.`);
}
function runCist(args, io) {
    const kaktusDir = path.resolve(args.options.get("kaktus"));
    const outFile = path.resolve(args.options.get("out"));
    requireDirectory(kaktusDir);
    const data = (0, read_1.readAll)(kaktusDir);
    (0, fs_util_1.writeJsonAtomic)(outFile, data);
    const dodavatelu = data.firmy.reduce((n, f) => n + (f.dodavatele?.length ?? 0), 0);
    const faktur = data.firmy.reduce((n, f) => n + (f.faktury?.length ?? 0), 0);
    io.out(`Načteno: ${data.firmy.length} firem, ${dodavatelu} dodavatelů, ${faktur} přijatých faktur. Výstup: ${outFile}`);
    return 0;
}
function runZapis(_args, io) {
    io.err("Příkaz zapis zatím není implementován.");
    return 1;
}
/** Spustí CLI, vrací exit kód (nevolá process.exit, aby šlo testovat). */
function main(argv, io = defaultIo) {
    try {
        if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
            io.out(USAGE);
            return 0;
        }
        const args = parseArgs(argv);
        return args.command === "cist" ? runCist(args, io) : runZapis(args, io);
    }
    catch (e) {
        if (e instanceof errors_1.VstupniChyba) {
            io.err(e.message);
            if (e instanceof errors_1.PouzitiChyba)
                io.err(USAGE);
            return 1;
        }
        io.err(`Neočekávaná chyba: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
