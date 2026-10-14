"use strict";
// Čtení dBase III (.DBF) – hlavička, deskriptory polí, záznamy včetně příznaku smazání.
// Jen čtení; do DBF nikdy nezapisujeme (zápis jde výhradně přes XML import Kaktusu).
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
exports.MAX_DBF_BYTES = void 0;
exports.parseDbf = parseDbf;
exports.readDbfFile = readDbfFile;
const fs = __importStar(require("node:fs"));
const codec_1 = require("./codec");
const errors_1 = require("./errors");
/** Kódová stránka CP852 (LDID 100), jediná, kterou Kaktus používá. */
const LDID_CP852 = 100;
/** Horní mez velikosti souboru, proti vyčerpání paměti u poškozeného/podstrčeného souboru. */
exports.MAX_DBF_BYTES = 256 * 1024 * 1024;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,10}$/;
const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
function chyba(label, text) {
    return new errors_1.VstupniChyba(`Soubor ${label} není platné DBF: ${text}.`);
}
function parseFields(buf, headerLen, label) {
    const fields = [];
    const seen = new Set();
    let offset = 32;
    for (;;) {
        if (offset >= headerLen)
            throw chyba(label, "chybí ukončení seznamu polí");
        if (buf[offset] === 0x0d)
            break;
        if (offset + 32 > headerLen)
            throw chyba(label, "nekompletní deskriptor pole");
        let name = "";
        for (let i = 0; i < 11 && buf[offset + i] !== 0; i++) {
            name += String.fromCharCode(buf[offset + i]);
        }
        if (!FIELD_NAME_RE.test(name))
            throw chyba(label, "neplatný název pole");
        if (seen.has(name))
            throw chyba(label, `duplicitní pole ${name}`);
        seen.add(name);
        const type = String.fromCharCode(buf[offset + 11]);
        if (type !== "C" && type !== "N" && type !== "D" && type !== "L") {
            throw chyba(label, `nepodporovaný typ pole ${name} (${JSON.stringify(type)})`);
        }
        const length = buf[offset + 16];
        const decimals = buf[offset + 17];
        if (length === 0)
            throw chyba(label, `pole ${name} má nulovou délku`);
        fields.push({ name, type, length, decimals });
        offset += 32;
    }
    if (fields.length === 0)
        throw chyba(label, "žádná pole");
    return fields;
}
function trimRightSpacesAndNul(s) {
    let end = s.length;
    while (end > 0 && (s.charCodeAt(end - 1) === 0x20 || s.charCodeAt(end - 1) === 0))
        end--;
    return s.slice(0, end);
}
function parseValue(field, raw, label, index) {
    const where = `záznam ${index + 1}, pole ${field.name}`;
    const text = (0, codec_1.decodeCp852)(raw);
    switch (field.type) {
        case "C":
            return trimRightSpacesAndNul(text);
        case "N": {
            const t = text.trim();
            return t === "" ? null : t;
        }
        case "D": {
            const t = text.trim();
            if (t === "")
                return null;
            const m = DATE_RE.exec(t);
            if (!m)
                throw chyba(label, `neplatné datum (${where})`);
            const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
            const dt = new Date(Date.UTC(y, mo - 1, d));
            if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
                throw chyba(label, `neexistující datum (${where})`);
            }
            return `${m[1]}-${m[2]}-${m[3]}`;
        }
        case "L": {
            const t = text.trim();
            if (t === "" || t === "?")
                return null;
            if (/^[TtYy]$/.test(t))
                return true;
            if (/^[FfNn]$/.test(t))
                return false;
            throw chyba(label, `neplatná logická hodnota (${where})`);
        }
    }
}
/**
 * Rozparsuje obsah DBF souboru. Čistá funkce bez I/O; `label` je jen pro hlášky.
 * Je přísná: při nesrovnalosti v hlavičce nebo záznamech vyhodí VstupniChyba.
 */
function parseDbf(buf, label) {
    if (buf.length < 33)
        throw chyba(label, "soubor je příliš krátký");
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf[0] !== 0x03)
        throw chyba(label, `nepodporovaná verze (0x${buf[0].toString(16)})`);
    const ldid = buf[29];
    if (ldid !== LDID_CP852) {
        throw chyba(label, `nepodporované kódování (LDID ${ldid}, očekáváno ${LDID_CP852} = CP852)`);
    }
    const count = dv.getUint32(4, true);
    const headerLen = dv.getUint16(8, true);
    const recLen = dv.getUint16(10, true);
    if (headerLen < 33 || headerLen > buf.length)
        throw chyba(label, "neplatná délka hlavičky");
    const fields = parseFields(buf, headerLen, label);
    const sum = fields.reduce((acc, f) => acc + f.length, 0);
    if (recLen !== sum + 1)
        throw chyba(label, "délka záznamu neodpovídá polím");
    if (headerLen + count * recLen > buf.length)
        throw chyba(label, "soubor je useknutý (méně záznamů než v hlavičce)");
    const records = [];
    for (let i = 0; i < count; i++) {
        const start = headerLen + i * recLen;
        const flag = buf[start];
        if (flag !== 0x20 && flag !== 0x2a)
            throw chyba(label, `neplatný příznak záznamu ${i + 1}`);
        const values = new Map();
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
function readDbfFile(file, label) {
    let buf;
    try {
        const st = fs.statSync(file);
        if (!st.isFile())
            throw new errors_1.VstupniChyba(`${label} není soubor.`);
        if (st.size > exports.MAX_DBF_BYTES)
            throw new errors_1.VstupniChyba(`Soubor ${label} je příliš velký.`);
        buf = fs.readFileSync(file);
    }
    catch (e) {
        if (e instanceof errors_1.VstupniChyba)
            throw e;
        const code = e.code;
        if (code === "ENOENT")
            throw new errors_1.VstupniChyba(`Soubor ${label} nebyl nalezen.`);
        throw new errors_1.VstupniChyba(`Soubor ${label} nelze přečíst (${code ?? "neznámá chyba"}).`);
    }
    return parseDbf(buf, label);
}
