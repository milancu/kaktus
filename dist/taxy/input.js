"use strict";
// Načtení a striktní validace vstupů z TAXY (klienti.json, doklady-k-zapisu.json).
// Vstup je nedůvěryhodný: kontrolujeme typy, hodnoty, délky a velikost souboru.
//
// Dvě úrovně chyb:
//  - chyba celého souboru (nečitelný, nevalidní JSON, špatná struktura, příliš velký) →
//    `VstupniChyba` (CLI skončí s exit kódem 1);
//  - chyba jednoho dokladu → doklad se odmítne s českým důvodem, ostatní se zpracují.
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
exports.DOC_ID_RE = exports.MAX_DOKLADU = exports.MAX_KLIENTU = exports.MAX_DOKLADY_BYTES = exports.MAX_KLIENTI_BYTES = void 0;
exports.readJsonFile = readJsonFile;
exports.parseJsonBuffer = parseJsonBuffer;
exports.loadKlienti = loadKlienti;
exports.loadDoklady = loadDoklady;
exports.parseKlienti = parseKlienti;
exports.parseDokladyFile = parseDokladyFile;
exports.peekDocId = peekDocId;
exports.parseIdentita = parseIdentita;
exports.amountToCents = amountToCents;
exports.kurzToString = kurzToString;
exports.parseDoklad = parseDoklad;
const fs = __importStar(require("node:fs"));
const node_util_1 = require("node:util");
const errors_1 = require("../errors");
const format_1 = require("../kaktus/format");
const read_1 = require("../kaktus/read");
exports.MAX_KLIENTI_BYTES = 1024 * 1024;
exports.MAX_DOKLADY_BYTES = 10 * 1024 * 1024;
exports.MAX_KLIENTU = 10_000;
exports.MAX_DOKLADU = 5_000;
/** ID dokladu končí v poznámce `TAXY:<id>` (60 znaků), proto je krátké a jen z bezpečných znaků. */
exports.DOC_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_NAME = 200;
const MAX_TEXT = 1000;
const MAX_SHORT = 100;
// ---------------------------------------------------------------------------
// Načtení souborů
// ---------------------------------------------------------------------------
/** Přečte JSON soubor s omezením velikosti (UTF-8, případný BOM se ignoruje). */
function readJsonFile(file, maxBytes, label) {
    let size;
    try {
        const st = fs.statSync(file);
        if (!st.isFile())
            throw new errors_1.VstupniChyba(`${label}: ${file} není soubor.`);
        size = st.size;
    }
    catch (e) {
        if (e instanceof errors_1.VstupniChyba)
            throw e;
        throw new errors_1.VstupniChyba(`${label}: soubor ${file} nelze přečíst.`);
    }
    if (size > maxBytes) {
        throw new errors_1.VstupniChyba(`${label}: soubor je větší než povolených ${Math.round(maxBytes / 1024)} KiB.`);
    }
    let buf;
    try {
        buf = fs.readFileSync(file);
    }
    catch {
        throw new errors_1.VstupniChyba(`${label}: soubor ${file} nelze přečíst.`);
    }
    if (buf.length > maxBytes)
        throw new errors_1.VstupniChyba(`${label}: soubor je větší než povoleno.`);
    return parseJsonBuffer(buf, label);
}
/** Čistá část načtení: bajty → JSON; chyba = `VstupniChyba`. */
function parseJsonBuffer(buf, label) {
    let text;
    try {
        text = new node_util_1.TextDecoder("utf-8", { fatal: true }).decode(buf);
    }
    catch {
        throw new errors_1.VstupniChyba(`${label}: soubor není v kódování UTF-8.`);
    }
    if (text.charCodeAt(0) === 0xfeff)
        text = text.slice(1);
    try {
        return JSON.parse(text);
    }
    catch {
        throw new errors_1.VstupniChyba(`${label}: soubor není platný JSON.`);
    }
}
function loadKlienti(file) {
    return parseKlienti(readJsonFile(file, exports.MAX_KLIENTI_BYTES, "klienti.json"));
}
/** Vrátí surové doklady (každý se validuje zvlášť, chybný doklad nesmí zahodit ostatní). */
function loadDoklady(file) {
    return parseDokladyFile(readJsonFile(file, exports.MAX_DOKLADY_BYTES, "doklady"));
}
// ---------------------------------------------------------------------------
// Validace (čisté funkce)
// ---------------------------------------------------------------------------
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Vlastní vlastnost objektu (ne zděděná). */
function prop(o, key) {
    return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}
function parseKlienti(json) {
    if (!isObject(json))
        throw new errors_1.VstupniChyba("klienti.json: očekáván objekt s polem „klienti“.");
    const list = prop(json, "klienti");
    if (!Array.isArray(list) || list.length === 0) {
        throw new errors_1.VstupniChyba("klienti.json: pole „klienti“ chybí nebo je prázdné.");
    }
    if (list.length > exports.MAX_KLIENTU)
        throw new errors_1.VstupniChyba("klienti.json: příliš mnoho klientů.");
    const out = [];
    const ids = new Set();
    const firmy = new Set();
    list.forEach((item, i) => {
        const where = `klienti.json: klient č. ${i + 1}`;
        if (!isObject(item))
            throw new errors_1.VstupniChyba(`${where} není objekt.`);
        const klientId = prop(item, "klientId");
        const nazev = prop(item, "nazev");
        const ico = prop(item, "ico");
        const firma = prop(item, "kaktusFirma");
        if (typeof klientId !== "number" || !Number.isSafeInteger(klientId) || klientId <= 0) {
            throw new errors_1.VstupniChyba(`${where}: „klientId“ musí být kladné celé číslo.`);
        }
        if (typeof nazev !== "string" || nazev.trim() === "" || nazev.length > MAX_NAME) {
            throw new errors_1.VstupniChyba(`${where}: „nazev“ chybí nebo je neplatný.`);
        }
        if (typeof ico !== "string" || !format_1.ICO_RE.test(ico)) {
            throw new errors_1.VstupniChyba(`${where}: „ico“ musí mít 1 až 8 číslic.`);
        }
        if (typeof firma !== "string" || !read_1.FIRMA_ID_RE.test(firma)) {
            throw new errors_1.VstupniChyba(`${where}: „kaktusFirma“ musí mít přesně 4 číslice.`);
        }
        if (ids.has(klientId))
            throw new errors_1.VstupniChyba(`klienti.json: klientId ${klientId} je uvedeno vícekrát.`);
        if (firmy.has(firma)) {
            throw new errors_1.VstupniChyba(`klienti.json: firma ${firma} je přiřazena více klientům; takovou konfiguraci nepodporujeme.`);
        }
        ids.add(klientId);
        firmy.add(firma);
        out.push({ klientId, nazev, ico: (0, format_1.normalizeIco)(ico), kaktusFirma: firma });
    });
    return out;
}
function parseDokladyFile(json) {
    if (!Array.isArray(json))
        throw new errors_1.VstupniChyba("Soubor s doklady musí obsahovat pole dokladů.");
    if (json.length > exports.MAX_DOKLADU) {
        throw new errors_1.VstupniChyba(`Soubor s doklady obsahuje víc než ${exports.MAX_DOKLADU} dokladů.`);
    }
    return json;
}
/** ID dokladu, je-li platné; jinak null (pro hlášení v reportu). */
function peekDocId(raw) {
    if (!isObject(raw))
        return null;
    const id = prop(raw, "id");
    return typeof id === "string" && exports.DOC_ID_RE.test(id) ? id : null;
}
/** Minimum nutné k autorizaci: id dokladu, klientId a IČO odběratele. */
function parseIdentita(raw) {
    if (!isObject(raw))
        return { ok: false, id: null, klientId: null, duvody: ["Doklad není objekt."] };
    const duvody = [];
    const id = peekDocId(raw);
    if (id === null)
        duvody.push("Chybí platné „id“ dokladu (1–40 znaků A–Z, a–z, 0–9, _ a -).");
    const kid = prop(raw, "klientId");
    const klientId = typeof kid === "number" && Number.isSafeInteger(kid) && kid > 0 ? kid : null;
    if (klientId === null)
        duvody.push("Chybí platné „klientId“ (kladné celé číslo).");
    const odb = prop(raw, "odberatel");
    const icoRaw = isObject(odb) ? prop(odb, "ico") : undefined;
    const odberatelIco = typeof icoRaw === "string" && format_1.ICO_RE.test(icoRaw) ? (0, format_1.normalizeIco)(icoRaw) : null;
    if (odberatelIco === null)
        duvody.push("Chybí platné IČO odběratele.");
    if (duvody.length > 0 || id === null || klientId === null || odberatelIco === null) {
        return { ok: false, id, klientId, duvody };
    }
    return { ok: true, identita: { id, klientId, odberatelIco } };
}
/** Čtečka polí, která sbírá chyby (české hlášky) místo vyhazování výjimek. */
class Fields {
    o;
    prefix;
    errors = [];
    constructor(o, prefix) {
        this.o = o;
        this.prefix = prefix;
    }
    name(key) {
        return `${this.prefix}${key}`;
    }
    /** Nepovinný řetězec: chybějící/null → null; prázdný (po ořezu mezer) → null. */
    optString(key, max) {
        const v = prop(this.o, key);
        if (v === undefined || v === null)
            return null;
        if (typeof v !== "string") {
            this.errors.push(`Pole „${this.name(key)}“ musí být text.`);
            return null;
        }
        if (v.length > max) {
            this.errors.push(`Pole „${this.name(key)}“ je delší než ${max} znaků.`);
            return null;
        }
        return v.trim() === "" ? null : v;
    }
    reqString(key, max) {
        const v = this.optString(key, max);
        if (v === null && !this.errors.some((e) => e.includes(`„${this.name(key)}“`))) {
            this.errors.push(`Pole „${this.name(key)}“ chybí nebo je prázdné.`);
        }
        return v;
    }
    optDate(key) {
        const v = this.optString(key, 10);
        if (v === null)
            return null;
        if (!format_1.DATE_RE.test(v) || !(0, format_1.isValidIsoDate)(v)) {
            this.errors.push(`Pole „${this.name(key)}“ není platné datum RRRR-MM-DD.`);
            return null;
        }
        return v;
    }
    reqDate(key) {
        const v = this.optDate(key);
        if (v === null && !this.errors.some((e) => e.includes(`„${this.name(key)}“`))) {
            this.errors.push(`Pole „${this.name(key)}“ chybí.`);
        }
        return v;
    }
    optIco(key) {
        const v = this.optString(key, 8);
        if (v === null)
            return null;
        if (!format_1.ICO_RE.test(v)) {
            this.errors.push(`Pole „${this.name(key)}“ musí mít 1 až 8 číslic.`);
            return null;
        }
        return (0, format_1.normalizeIco)(v);
    }
}
/**
 * Částka z JSONu (číslo) → haléře. Použije se nejkratší textový zápis čísla a regex Kaktusu
 * (max. 8 číslic, max. 2 desetinná místa), takže 0.1 + 0.2 apod. neprojde a nic se nezaokrouhluje.
 */
function amountToCents(v) {
    if (typeof v !== "number" || !Number.isFinite(v))
        return null;
    const text = String(v);
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!m || !format_1.AMOUNT_RE.test(text))
        return null;
    const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
    return m[1] === "-" ? -cents : cents;
}
/** Kurz z JSONu (číslo) → řetězec ve formátu Kaktusu; null při neplatné hodnotě. */
function kurzToString(v) {
    if (typeof v !== "number" || !Number.isFinite(v))
        return null;
    const text = String(v);
    return format_1.KURZ_RE.test(text) && v > 0 ? text : null;
}
const SAZBY = [0, 12, 21];
/** Plná validace jednoho dokladu. Neověřuje autorizaci (ta je nadřazená, viz plan.ts). */
function parseDoklad(raw) {
    if (!isObject(raw))
        return { ok: false, duvody: ["Doklad není objekt."] };
    const f = new Fields(raw, "");
    const varovani = [];
    if (prop(raw, "typ") !== "faktura_prijata")
        f.errors.push("Nepodporovaný typ dokladu (očekáváno faktura_prijata).");
    if (prop(raw, "stav") !== "schvaleno")
        f.errors.push("Doklad není ve stavu „schváleno“.");
    const ident = parseIdentita(raw);
    if (!ident.ok)
        f.errors.push(...ident.duvody);
    const cisloDokladu = f.reqString("cisloDokladu", MAX_SHORT);
    const variabilniSymbol = f.optString("variabilniSymbol", MAX_SHORT);
    const popis = f.optString("popis", MAX_TEXT);
    const datumVystaveni = f.reqDate("datumVystaveni");
    const duzp = f.optDate("duzp");
    const datumSplatnosti = f.optDate("datumSplatnosti");
    // Dodavatel
    let dodavatel = null;
    const dodRaw = prop(raw, "dodavatel");
    if (!isObject(dodRaw)) {
        f.errors.push("Chybí objekt „dodavatel“.");
    }
    else {
        const d = new Fields(dodRaw, "dodavatel.");
        const nazev = d.reqString("nazev", MAX_NAME);
        const ico = d.optIco("ico");
        const dic = d.optString("dic", MAX_SHORT);
        const ulice = d.optString("ulice", MAX_NAME);
        const mesto = d.optString("mesto", MAX_NAME);
        const psc = d.optString("psc", MAX_SHORT);
        const stat = d.optString("stat", 2);
        if (stat !== null && !format_1.STAT_RE.test(stat))
            d.errors.push("Pole „dodavatel.stat“ musí být dvoupísmenný kód státu.");
        f.errors.push(...d.errors);
        if (nazev !== null && d.errors.length === 0) {
            dodavatel = { nazev, ico, dic, ulice, mesto, psc, stat: stat === null ? null : stat.toUpperCase() };
        }
    }
    // Měna a kurz
    const mena = f.reqString("mena", 3);
    if (mena !== null && !format_1.MENA_RE.test(mena))
        f.errors.push("Pole „mena“ musí být třípísmenný kód velkými písmeny.");
    let kurz = null;
    const kurzRaw = prop(raw, "kurz");
    if (mena !== null && format_1.MENA_RE.test(mena)) {
        if (mena === "CZK") {
            if (kurzRaw !== undefined && kurzRaw !== null)
                varovani.push("Kurz u dokladu v CZK se ignoruje.");
        }
        else {
            kurz = kurzToString(kurzRaw);
            if (kurz === null)
                f.errors.push("U dokladu v cizí měně chybí platný kurz (kladné číslo, max. 4+4 číslice).");
        }
    }
    // Částky a rozpis DPH
    const sums = { zaklad0: 0, zaklad12: 0, dph12: 0, zaklad21: 0, dph21: 0 };
    const rozpis = prop(raw, "rozpisDph");
    if (!Array.isArray(rozpis) || rozpis.length === 0 || rozpis.length > SAZBY.length) {
        f.errors.push("Pole „rozpisDph“ musí obsahovat 1 až 3 položky.");
    }
    else {
        const seen = new Set();
        rozpis.forEach((item, i) => {
            const w = `rozpisDph[${i + 1}]`;
            if (!isObject(item)) {
                f.errors.push(`${w} není objekt.`);
                return;
            }
            const sazba = prop(item, "sazba");
            const zaklad = amountToCents(prop(item, "zaklad"));
            const dph = amountToCents(prop(item, "dph"));
            if (typeof sazba !== "number" || !SAZBY.includes(sazba)) {
                f.errors.push(`${w}: nepodporovaná sazba DPH (povoleno 0, 12, 21).`);
                return;
            }
            if (seen.has(sazba)) {
                f.errors.push(`${w}: sazba ${sazba} je v rozpisu uvedena vícekrát.`);
                return;
            }
            seen.add(sazba);
            if (zaklad === null || dph === null) {
                f.errors.push(`${w}: neplatná částka (nejvýše 8 číslic a 2 desetinná místa).`);
                return;
            }
            if (sazba === 0) {
                if (dph !== 0)
                    f.errors.push(`${w}: u sazby 0 % musí být daň nulová.`);
                sums.zaklad0 = zaklad;
            }
            else if (sazba === 12) {
                sums.zaklad12 = zaklad;
                sums.dph12 = dph;
            }
            else {
                sums.zaklad21 = zaklad;
                sums.dph21 = dph;
            }
        });
    }
    const celkem = amountToCents(prop(raw, "celkem"));
    if (celkem === null)
        f.errors.push("Pole „celkem“ chybí nebo není platná částka (nejvýše 8 číslic a 2 desetinná místa).");
    // Odběratel (pro autorizaci řeší parseIdentita, tady jen jeho hodnota do výsledku)
    if (f.errors.length > 0 || !ident.ok || cisloDokladu === null || datumVystaveni === null || dodavatel === null ||
        mena === null || celkem === null) {
        return { ok: false, duvody: f.errors };
    }
    return {
        ok: true,
        doklad: {
            id: ident.identita.id,
            klientId: ident.identita.klientId,
            cisloDokladu,
            variabilniSymbol,
            dodavatel,
            odberatelIco: ident.identita.odberatelIco,
            datumVystaveni,
            duzp,
            datumSplatnosti,
            ...sums,
            celkem,
            mena,
            kurz,
            popis,
            varovani,
        },
    };
}
