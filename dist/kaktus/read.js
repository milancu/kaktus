"use strict";
// Čtení dat Kaktusu: FIRMY, ADRESAR, FAKPRI → doménové objekty.
// Funkce jsou navržené pro opětovné použití v zápisu (readFirmaData podle ID firmy).
// Smazané záznamy se nevynechávají, jsou označené `smazano: true`.
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
exports.SLOZKA_RE = exports.FIRMA_ID_RE = void 0;
exports.parseCents = parseCents;
exports.centsToDecimal = centsToDecimal;
exports.parseInteger = parseInteger;
exports.icoFromNumber = icoFromNumber;
exports.icoFromText = icoFromText;
exports.mapFirmy = mapFirmy;
exports.mapDodavatele = mapDodavatele;
exports.mapFaktury = mapFaktury;
exports.resolveFirmaDir = resolveFirmaDir;
exports.readFirmy = readFirmy;
exports.readDodavatele = readDodavatele;
exports.readFaktury = readFaktury;
exports.readFirmaData = readFirmaData;
exports.readAll = readAll;
exports.toFakturaVystup = toFakturaVystup;
exports.toVystup = toVystup;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const dbf_1 = require("../dbf");
const errors_1 = require("../errors");
exports.FIRMA_ID_RE = /^\d{4}$/;
exports.SLOZKA_RE = /^[A-Za-z0-9_-]{1,8}$/;
const ICO_RE = /^\d{1,8}$/;
const CASTKA_POLE = ["zaklad0", "zaklad12", "dph12", "zaklad21", "dph21", "celkem"];
// ---------------------------------------------------------------------------
// Čisté pomocné funkce (bez I/O)
// ---------------------------------------------------------------------------
/** Převede text částky z DBF (např. `2440.57`, `-12`) na haléře. Nic nezaokrouhluje, nepoužívá float. */
function parseCents(text, where) {
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!m)
        throw new errors_1.VstupniChyba(`Neplatná částka "${text}" (${where}).`);
    const whole = Number(m[2]);
    const frac = Number((m[3] ?? "").padEnd(2, "0"));
    const cents = whole * 100 + frac;
    if (!Number.isSafeInteger(cents))
        throw new errors_1.VstupniChyba(`Částka je mimo rozsah (${where}).`);
    return m[1] === "-" ? -cents : cents;
}
/** Haléře → desetinný text s tečkou a dvěma místy (244057 → "2440.57"). Bez floatu. */
function centsToDecimal(cents) {
    if (!Number.isSafeInteger(cents))
        throw new Error("Částka musí být celé číslo haléřů.");
    const abs = Math.abs(cents);
    return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
function parseInteger(text, where) {
    if (!/^-?\d{1,15}$/.test(text))
        throw new errors_1.VstupniChyba(`Neplatné celé číslo "${text}" (${where}).`);
    return Number(text);
}
/** Číselné IČO z DBF → 8 číslic s úvodními nulami. */
function icoFromNumber(value, where) {
    if (!Number.isInteger(value) || value < 0 || value > 99999999) {
        throw new errors_1.VstupniChyba(`Neplatné IČO ${value} (${where}).`);
    }
    return String(value).padStart(8, "0");
}
/** IČO z textového pole (FIRMY.ICO): prázdné → null, jinak 1–8 číslic doplněných nulami na 8. */
function icoFromText(text, where) {
    const t = text.trim();
    if (t === "")
        return null;
    if (!ICO_RE.test(t))
        throw new errors_1.VstupniChyba(`Neplatné IČO "${t}" (${where}).`);
    return t.padStart(8, "0");
}
function isInside(base, target) {
    const rel = path.relative(base, target);
    if (rel === "" || path.isAbsolute(rel))
        return false;
    return rel.split(path.sep)[0] !== "..";
}
function requireFields(table, label, spec) {
    for (const [name, type] of Object.entries(spec)) {
        const f = table.fields.find((x) => x.name === name);
        if (!f || f.type !== type) {
            throw new errors_1.VstupniChyba(`Soubor ${label} nemá očekávané pole ${name} (${type}).`);
        }
    }
}
function str(rec, name) {
    const v = rec.values.get(name);
    return typeof v === "string" ? v : "";
}
function strOrNull(rec, name) {
    const s = str(rec, name).trim();
    return s === "" ? null : s;
}
function num(rec, name) {
    const v = rec.values.get(name);
    return typeof v === "string" ? v : null;
}
function date(rec, name) {
    const v = rec.values.get(name);
    return typeof v === "string" ? v : null;
}
function where(label, rec, name) {
    return `${label}, záznam ${rec.index + 1}, pole ${name}`;
}
function intField(rec, name, label) {
    const t = num(rec, name);
    return t === null ? null : parseInteger(t, where(label, rec, name));
}
function centsField(rec, name, label) {
    const t = num(rec, name);
    return t === null ? null : parseCents(t, where(label, rec, name));
}
// ---------------------------------------------------------------------------
// Převod tabulek na doménové objekty (čisté funkce)
// ---------------------------------------------------------------------------
function mapFirmy(table, label) {
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
function mapDodavatele(table, label) {
    requireFields(table, label, {
        ID: "N", NAZEV: "C", ICO: "N", DIC: "C", ULICE: "C", MESTO: "C", PSC: "C", STAT: "C", UCET: "C", POZN: "C",
    });
    return table.records.map((rec) => {
        const id = intField(rec, "ID", label);
        if (id === null)
            throw new errors_1.VstupniChyba(`Chybí ID (${where(label, rec, "ID")}).`);
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
function mapFaktury(table, label) {
    requireFields(table, label, {
        ID: "N", DOKLAD: "C", CISLODOD: "C", VS: "C", PARTNER: "N",
        DATVYST: "D", DATZDAN: "D", DATSPL: "D", DATUHR: "D",
        ZAKL0: "N", ZAKL12: "N", DPH12: "N", ZAKL21: "N", DPH21: "N", CELKEM: "N",
        MENA: "C", KURZ: "N", TEXT: "C", POZN: "C",
    });
    return table.records.map((rec) => {
        const id = intField(rec, "ID", label);
        if (id === null)
            throw new errors_1.VstupniChyba(`Chybí ID (${where(label, rec, "ID")}).`);
        const kurzText = num(rec, "KURZ");
        let kurz = null;
        if (kurzText !== null) {
            if (!/^-?\d+(\.\d{1,4})?$/.test(kurzText)) {
                throw new errors_1.VstupniChyba(`Neplatný kurz "${kurzText}" (${where(label, rec, "KURZ")}).`);
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
function resolveFirmaDir(kaktusDir, firma) {
    if (!exports.FIRMA_ID_RE.test(firma.id))
        throw new errors_1.VstupniChyba(`Neplatné ID firmy "${firma.id}" (očekáváno 4 číslice).`);
    if (!exports.SLOZKA_RE.test(firma.slozka))
        throw new errors_1.VstupniChyba(`Neplatná složka firmy ${firma.id}.`);
    if (firma.slozka !== firma.id) {
        throw new errors_1.VstupniChyba(`Složka firmy ${firma.id} se liší od jejího ID; takovou konfiguraci nepodporujeme.`);
    }
    const dataDir = path.resolve(kaktusDir, "DATA");
    const dir = path.resolve(dataDir, firma.slozka);
    if (!isInside(dataDir, dir))
        throw new errors_1.VstupniChyba(`Složka firmy ${firma.id} leží mimo DATA.`);
    let realData;
    let realDir;
    try {
        realData = fs.realpathSync(dataDir);
        realDir = fs.realpathSync(dir);
    }
    catch {
        throw new errors_1.VstupniChyba(`Složka firmy ${firma.id} neexistuje.`);
    }
    if (!isInside(realData, realDir))
        throw new errors_1.VstupniChyba(`Složka firmy ${firma.id} leží mimo DATA.`);
    return dir;
}
function readFirmy(kaktusDir) {
    const label = "DATA/FIRMY.DBF";
    const firmy = mapFirmy((0, dbf_1.readDbfFile)(path.resolve(kaktusDir, "DATA", "FIRMY.DBF"), label), label);
    const seen = new Set();
    for (const f of firmy) {
        if (f.smazano)
            continue;
        if (seen.has(f.id))
            throw new errors_1.VstupniChyba(`Firma ${f.id} je ve FIRMY.DBF uvedena vícekrát.`);
        seen.add(f.id);
    }
    return firmy;
}
function readDodavatele(firmaDir, firmaId) {
    const label = `DATA/${firmaId}/ADRESAR.DBF`;
    return mapDodavatele((0, dbf_1.readDbfFile)(path.join(firmaDir, "ADRESAR.DBF"), label), label);
}
function readFaktury(firmaDir, firmaId) {
    const label = `DATA/${firmaId}/FAKPRI.DBF`;
    return mapFaktury((0, dbf_1.readDbfFile)(path.join(firmaDir, "FAKPRI.DBF"), label), label);
}
/** Data jedné firmy podle jejího ID (znovu použitelné v zápisu, např. pro opětovné načtení FAKPRI). */
function readFirmaData(kaktusDir, firmaId) {
    if (!exports.FIRMA_ID_RE.test(firmaId))
        throw new errors_1.VstupniChyba(`Neplatné ID firmy "${firmaId}" (očekáváno 4 číslice).`);
    const firma = readFirmy(kaktusDir).find((f) => f.id === firmaId && !f.smazano);
    if (!firma)
        throw new errors_1.VstupniChyba(`Firma ${firmaId} není ve FIRMY.DBF.`);
    const dir = resolveFirmaDir(kaktusDir, firma);
    return { firma, dodavatele: readDodavatele(dir, firma.id), faktury: readFaktury(dir, firma.id) };
}
/** Všechny firmy s dodavateli a přijatými fakturami (částky v haléřích). */
function readAll(kaktusDir) {
    const firmy = readFirmy(kaktusDir).map((firma) => {
        if (firma.smazano)
            return { ...firma, dodavatele: null, faktury: null };
        const dir = resolveFirmaDir(kaktusDir, firma);
        return { ...firma, dodavatele: readDodavatele(dir, firma.id), faktury: readFaktury(dir, firma.id) };
    });
    return { firmy };
}
function toFakturaVystup(f) {
    const out = { ...f, kurz: f.kurz === null ? null : f.kurz.toFixed(4) };
    for (const k of CASTKA_POLE) {
        const v = f[k];
        out[k] = v === null ? null : centsToDecimal(v);
    }
    return out;
}
/** Výstup příkazu `cist` (JSON pro TAXY): částky jako desetinné řetězce, viz `FakturaVystup`. */
function toVystup(data) {
    return {
        format: 2,
        firmy: data.firmy.map((f) => ({ ...f, faktury: f.faktury === null ? null : f.faktury.map(toFakturaVystup) })),
    };
}
