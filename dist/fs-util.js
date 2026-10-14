"use strict";
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
exports.writeFileAtomic = writeFileAtomic;
exports.writeJsonAtomic = writeJsonAtomic;
exports.assertOutputWritable = assertOutputWritable;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const errors_1 = require("./errors");
/** Smaže dočasný adresář; selhání (EBUSY/EPERM…) se ignoruje, aby neshodilo už hotovou práci. */
function removeTmpBestEffort(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    catch {
        // zůstane prázdný/dočasný adresář vedle cíle; výsledek zápisu se tím nemění
    }
}
/**
 * Atomicky zapíše text do souboru: dočasný soubor vznikne v unikátním adresáři (`fs.mkdtemp`)
 * ve stejné složce jako cíl, a poté se přejmenuje na cíl. Čtenář tak nikdy neuvidí napůl
 * zapsaný soubor. Nadřazené složky se případně vytvoří. Úklid dočasného adresáře je best-effort
 * (po úspěšném přejmenování nesmí selhání úklidu zápis „zneplatnit“).
 */
function writeFileAtomic(file, content) {
    const target = path.resolve(file);
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(dir, ".tmp-"));
    const tmpFile = path.join(tmpDir, "data");
    try {
        const fd = fs.openSync(tmpFile, "wx", 0o644);
        try {
            fs.writeSync(fd, content, 0, "utf8");
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmpFile, target);
    }
    finally {
        removeTmpBestEffort(tmpDir);
    }
}
/** Atomicky zapíše JSON (UTF-8, odsazení 2 mezery, koncový nový řádek). */
function writeJsonAtomic(file, data) {
    writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}
/**
 * Ověří cíl výstupního souboru ještě před jakoukoli prací s Kaktusem: nadřazená složka existuje
 * a je do ní možné zapisovat (zkušební `mkdtemp`) a cíl není složka. Zápis reportu po importu
 * by jinak mohl selhat, když už jsou doklady v Kaktusu zapsané.
 */
function assertOutputWritable(file) {
    const target = path.resolve(file);
    const dir = path.dirname(target);
    let dirOk = false;
    try {
        dirOk = fs.statSync(dir).isDirectory();
    }
    catch {
        // nenalezeno / nedostupné
    }
    if (!dirOk)
        throw new errors_1.VstupniChyba(`Složka pro výstup "${dir}" neexistuje.`);
    let targetIsDir = false;
    try {
        targetIsDir = fs.statSync(target).isDirectory();
    }
    catch {
        // cíl zatím neexistuje – v pořádku
    }
    if (targetIsDir)
        throw new errors_1.VstupniChyba(`Výstup "${target}" je složka, očekává se soubor.`);
    try {
        removeTmpBestEffort(fs.mkdtempSync(path.join(dir, ".tmp-")));
    }
    catch {
        throw new errors_1.VstupniChyba(`Do složky "${dir}" nelze zapisovat.`);
    }
}
