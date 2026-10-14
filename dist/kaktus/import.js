"use strict";
// Spuštění importu Kaktusu a parsování jeho odpovědi.
//
//  - Import se spouští jen přes `execFile(process.execPath, [kaktus.cjs, "import", dávka, odpověď])`:
//    pole argumentů, `shell: false`, timeout, žádné skládání příkazu ze stringu.
//  - Každá dávka dostane nový dočasný adresář (`fs.mkdtemp`) a odpověď se píše do nového souboru
//    v něm; starou odpověď nelze přečíst, adresář se po zpracování smaže.
//  - Odpověď je jen nápověda (pravdu má DBF); parser je přesto striktní a minimální:
//    `<!DOCTYPE`, `<!ENTITY`, komentáře, CDATA a processing instructions se odmítají.
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
exports.defaultRunner = exports.OdpovedChyba = exports.MAX_ODPOVED_BYTES = exports.DEFAULT_IMPORT_TIMEOUT_MS = void 0;
exports.decodeEntities = decodeEntities;
exports.parseOdpoved = parseOdpoved;
exports.resolveKaktusScript = resolveKaktusScript;
exports.mapExitCode = mapExitCode;
exports.runImport = runImport;
exports.importDavka = importDavka;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_util_1 = require("node:util");
const codec_1 = require("../codec");
const errors_1 = require("../errors");
const read_1 = require("./read");
exports.DEFAULT_IMPORT_TIMEOUT_MS = 60_000;
exports.MAX_ODPOVED_BYTES = 1024 * 1024;
const MAX_ZPRAVA = 300;
/** Odpověď Kaktusu nelze použít (neplatný tvar, zakázaná konstrukce, nesedící `poradi`…). */
class OdpovedChyba extends Error {
    constructor(message) {
        super(message);
        this.name = "OdpovedChyba";
    }
}
exports.OdpovedChyba = OdpovedChyba;
const XML_DECL_RE = /^<\?xml(\s[^?>]*)?\?>/;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_.-]*/y;
const WS_RE = /\s*/y;
const ATTR_RE = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
function skipWs(text, pos) {
    WS_RE.lastIndex = pos;
    WS_RE.exec(text);
    return WS_RE.lastIndex;
}
/** Dekóduje hodnoty atributu; povoleny jen pět základních entit a číselné odkazy na platné znaky XML. */
function decodeEntities(value) {
    return value.replace(/&([^;&\s]*);?/g, (all, body) => {
        if (!all.endsWith(";"))
            throw new OdpovedChyba("Neplatný znak & v odpovědi.");
        switch (body) {
            case "amp": return "&";
            case "lt": return "<";
            case "gt": return ">";
            case "quot": return '"';
            case "apos": return "'";
            default: break;
        }
        let cp = NaN;
        if (/^#x[0-9A-Fa-f]{1,6}$/.test(body))
            cp = parseInt(body.slice(2), 16);
        else if (/^#\d{1,7}$/.test(body))
            cp = parseInt(body.slice(1), 10);
        else
            throw new OdpovedChyba("Neznámá entita v odpovědi.");
        if (!Number.isInteger(cp) || cp > 0x10ffff || !(0, codec_1.isXmlChar)(cp)) {
            throw new OdpovedChyba("Neplatný číselný odkaz na znak v odpovědi.");
        }
        return String.fromCodePoint(cp);
    });
}
function readTag(text, pos) {
    if (text[pos] !== "<")
        throw new OdpovedChyba("Odpověď: očekáván element.");
    let p = pos + 1;
    let closing = false;
    if (text[p] === "/") {
        closing = true;
        p++;
    }
    NAME_RE.lastIndex = p;
    const m = NAME_RE.exec(text);
    if (m === null)
        throw new OdpovedChyba("Odpověď: neplatný název elementu.");
    const name = m[0];
    p = NAME_RE.lastIndex;
    const attrs = new Map();
    if (!closing) {
        for (;;) {
            ATTR_RE.lastIndex = p;
            const a = ATTR_RE.exec(text);
            if (a === null)
                break;
            const key = a[1];
            if (attrs.has(key))
                throw new OdpovedChyba(`Odpověď: atribut ${key} je uveden dvakrát.`);
            attrs.set(key, decodeEntities((a[2] ?? a[3])));
            p = ATTR_RE.lastIndex;
        }
    }
    p = skipWs(text, p);
    if (closing) {
        if (text[p] !== ">")
            throw new OdpovedChyba("Odpověď: neplatná koncová značka.");
        return { kind: "close", name, attrs, next: p + 1 };
    }
    if (text.startsWith("/>", p))
        return { kind: "empty", name, attrs, next: p + 2 };
    if (text[p] === ">")
        return { kind: "open", name, attrs, next: p + 1 };
    throw new OdpovedChyba("Odpověď: neplatná značka (atribut musí být v uvozovkách).");
}
function decodeBody(bytes) {
    const head = Buffer.from(bytes.subarray(0, 200)).toString("latin1");
    const decl = XML_DECL_RE.exec(head);
    const enc = decl === null ? null : /\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(decl[0]);
    const name = enc === null ? "windows-1250" : enc[1].toLowerCase();
    if (name === "windows-1250" || name === "cp1250")
        return (0, codec_1.decodeWin1250)(bytes);
    if (name === "utf-8" || name === "utf8") {
        try {
            return new node_util_1.TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        catch {
            throw new OdpovedChyba("Odpověď není platné UTF-8.");
        }
    }
    throw new OdpovedChyba("Odpověď má nepodporované kódování.");
}
function cleanMessage(s) {
    let out = "";
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        out += cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || !(0, codec_1.isXmlChar)(cp) ? " " : ch;
    }
    out = out.replace(/\s+/g, " ").trim();
    return out.length > MAX_ZPRAVA ? `${out.slice(0, MAX_ZPRAVA)}…` : out;
}
function parseDokladElement(attrs, pocet) {
    const poradiText = attrs.get("poradi");
    if (poradiText === undefined || !/^\d{1,4}$/.test(poradiText))
        throw new OdpovedChyba("Odpověď: chybí nebo je neplatné poradi.");
    const poradi = Number(poradiText);
    if (poradi < 1 || poradi > pocet)
        throw new OdpovedChyba(`Odpověď: poradi ${poradi} je mimo rozsah dávky (1–${pocet}).`);
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
        if (kod === undefined || !/^E\d{3}$/.test(kod))
            throw new OdpovedChyba(`Odpověď: doklad ${poradi} nemá platný kód chyby.`);
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
function parseOdpoved(bytes, ocekavani) {
    if (bytes.length > exports.MAX_ODPOVED_BYTES)
        throw new OdpovedChyba("Odpověď je příliš velká.");
    const text = decodeBody(bytes);
    if (/<!\s*(DOCTYPE|ENTITY)/i.test(text))
        throw new OdpovedChyba("Odpověď obsahuje zakázanou konstrukci DOCTYPE/ENTITY.");
    let pos = 0;
    const decl = XML_DECL_RE.exec(text);
    if (decl !== null)
        pos = decl[0].length;
    pos = skipWs(text, pos);
    if (text.startsWith("<!", pos) || text.startsWith("<?", pos)) {
        throw new OdpovedChyba("Odpověď obsahuje nepovolenou konstrukci (komentář, CDATA nebo processing instruction).");
    }
    const root = readTag(text, pos);
    if (root.kind === "close" || root.name !== "KaktusOdpoved")
        throw new OdpovedChyba("Kořenový element musí být KaktusOdpoved.");
    const firma = root.attrs.get("firma");
    if (firma === undefined || !read_1.FIRMA_ID_RE.test(firma))
        throw new OdpovedChyba("Odpověď nemá platné ID firmy.");
    if (firma !== ocekavani.firma)
        throw new OdpovedChyba("Odpověď se týká jiné firmy, než do které se importovalo.");
    const doklady = new Map();
    pos = root.next;
    if (root.kind === "open") {
        for (;;) {
            pos = skipWs(text, pos);
            if (pos >= text.length)
                throw new OdpovedChyba("Odpověď je useknutá.");
            if (text.startsWith("<!", pos) || text.startsWith("<?", pos)) {
                throw new OdpovedChyba("Odpověď obsahuje nepovolenou konstrukci (komentář, CDATA nebo processing instruction).");
            }
            const tag = readTag(text, pos);
            pos = tag.next;
            if (tag.kind === "close") {
                if (tag.name !== "KaktusOdpoved")
                    throw new OdpovedChyba("Odpověď: nesedí koncová značka.");
                break;
            }
            if (tag.name !== "Doklad")
                throw new OdpovedChyba("Odpověď: neočekávaný element.");
            if (tag.kind === "open") {
                const close = readTag(text, skipWs(text, pos));
                if (close.kind !== "close" || close.name !== "Doklad")
                    throw new OdpovedChyba("Odpověď: element Doklad nesmí mít obsah.");
                pos = close.next;
            }
            const d = parseDokladElement(tag.attrs, ocekavani.pocet);
            if (doklady.has(d.poradi))
                throw new OdpovedChyba(`Odpověď: poradi ${d.poradi} je uvedeno dvakrát.`);
            doklady.set(d.poradi, d);
        }
    }
    if (skipWs(text, pos) !== text.length)
        throw new OdpovedChyba("Odpověď: za kořenovým elementem je další obsah.");
    return { firma, doklady };
}
/** Cesta ke `kaktus.cjs` ve složce Kaktusu; musí existovat jako soubor. */
function resolveKaktusScript(kaktusDir) {
    const script = path.resolve(kaktusDir, "kaktus.cjs");
    let ok = false;
    try {
        ok = fs.statSync(script).isFile();
    }
    catch {
        // hláška níže
    }
    if (!ok)
        throw new errors_1.VstupniChyba(`Ve složce Kaktusu "${kaktusDir}" chybí soubor kaktus.cjs.`);
    return script;
}
/** Mapování exit kódu importu (0–4 podle simulátoru) na stav. */
function mapExitCode(exitCode, timedOut) {
    if (timedOut)
        return { stav: "pad", detail: "Import překročil časový limit." };
    switch (exitCode) {
        case 0: return { stav: "zpracovano" };
        case 2: return { stav: "davka_necitelna" };
        case 3: return { stav: "firma_zamcena" };
        case 4: return { stav: "firma_neexistuje" };
        default: return { stav: "pad", detail: exitCode === null ? "Import skončil neočekávaně." : `Import skončil s kódem ${exitCode}.` };
    }
}
/** Výchozí spouštěč: `execFile(process.execPath, [kaktus.cjs, "import", dávka, odpověď])`, bez shellu. */
const defaultRunner = (vstup) => {
    const script = resolveKaktusScript(vstup.kaktusDir);
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)(process.execPath, [script, "import", vstup.davkaPath, vstup.odpovedPath], { shell: false, timeout: vstup.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, cwd: path.dirname(script) }, (error) => {
            if (error === null) {
                resolve({ exitCode: 0 });
                return;
            }
            const e = error;
            if (typeof e.code === "number")
                resolve({ exitCode: e.code });
            else
                resolve({ exitCode: null, timedOut: e.killed === true || (e.signal ?? null) !== null });
        });
    });
};
exports.defaultRunner = defaultRunner;
function readOdpoved(odpovedPath, ocekavani) {
    let bytes;
    try {
        const st = fs.statSync(odpovedPath);
        if (!st.isFile())
            return { odpoved: null, odpovedChyba: "Odpověď není soubor." };
        if (st.size > exports.MAX_ODPOVED_BYTES)
            return { odpoved: null, odpovedChyba: "Odpověď je příliš velká." };
        bytes = fs.readFileSync(odpovedPath);
    }
    catch {
        return { odpoved: null };
    }
    try {
        return { odpoved: parseOdpoved(bytes, ocekavani) };
    }
    catch (e) {
        if (e instanceof OdpovedChyba)
            return { odpoved: null, odpovedChyba: e.message };
        throw e;
    }
}
/**
 * Spustí import dávky a zpracuje výsledek. Nikdy nevyhazuje kvůli pádu importu (včetně výjimky
 * ze spouštěče) – pád je výsledek `pad`. Odpověď se čte, kdykoli soubor existuje (i po pádu);
 * volající musí zajistit, že `odpovedPath` je v čerstvém adresáři.
 */
async function runImport(kaktusDir, davkaPath, odpovedPath, opts) {
    const runner = opts.runner ?? exports.defaultRunner;
    let exitCode = null;
    let timedOut = false;
    let thrown = false;
    try {
        const r = await runner({ kaktusDir, davkaPath, odpovedPath, timeoutMs: opts.timeoutMs ?? exports.DEFAULT_IMPORT_TIMEOUT_MS });
        exitCode = r.exitCode;
        timedOut = r.timedOut === true;
    }
    catch {
        thrown = true;
    }
    const mapped = thrown ? { stav: "pad", detail: "Import skončil chybou." } : mapExitCode(exitCode, timedOut);
    return { ...mapped, exitCode, ...readOdpoved(odpovedPath, opts) };
}
/**
 * Zapíše dávku do nového dočasného adresáře (`fs.mkdtemp`), spustí import s odpovědí v novém
 * souboru téhož adresáře a adresář vždy smaže.
 */
async function importDavka(kaktusDir, xml, opts) {
    const dir = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "taxy-kaktus-"));
    try {
        const davkaPath = path.join(dir, "davka.xml");
        const odpovedPath = path.join(dir, "odpoved.xml");
        fs.writeFileSync(davkaPath, xml, { flag: "wx", mode: 0o600 });
        return await runImport(kaktusDir, davkaPath, odpovedPath, opts);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
