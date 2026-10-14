"use strict";
// Stavba XML dávky pro import do Kaktusu (čisté funkce bez I/O).
//
// Pravidla:
//  - každá textová hodnota jde přes jedinou funkci `escapeXml`;
//  - názvy elementů jsou konstanty (typ `ElementName`), z dat se nikdy neskládají;
//  - dávka je Win-1250 bez BOM (tak ji Kaktus čte) a obsahuje nejvýše 20 dokladů
//    (Kaktus zbytek potichu ignoruje);
//  - částky jsou v haléřích a na text se převádějí až tady.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BATCH_SIZE = void 0;
exports.escapeXml = escapeXml;
exports.formatCents = formatCents;
exports.buildBatchXml = buildBatchXml;
exports.buildBatches = buildBatches;
const codec_1 = require("../codec");
const format_1 = require("./format");
const read_1 = require("./read");
/** Kaktus zpracuje jen prvních 20 dokladů dávky. */
exports.MAX_BATCH_SIZE = 20;
/**
 * Jediná escape funkce pro hodnoty v XML. Nejdřív zahodí znaky neplatné v XML 1.0 (řídicí
 * znaky, nepárové surrogáty), potom nahradí `& < > " '`.
 */
function escapeXml(value) {
    let out = "";
    for (const ch of value) {
        if (!(0, codec_1.isXmlChar)(ch.codePointAt(0)))
            continue;
        switch (ch) {
            case "&":
                out += "&amp;";
                break;
            case "<":
                out += "&lt;";
                break;
            case ">":
                out += "&gt;";
                break;
            case '"':
                out += "&quot;";
                break;
            case "'":
                out += "&apos;";
                break;
            default: out += ch;
        }
    }
    return out;
}
/** Haléře → text částky s tečkou a dvěma desetinnými místy (např. 244057 → "2440.57"). */
function formatCents(cents) {
    if (!Number.isSafeInteger(cents))
        throw new Error("Částka musí být celé číslo haléřů.");
    const abs = Math.abs(cents);
    const text = `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
    if (!format_1.AMOUNT_OUT_RE.test(text))
        throw new Error("Částka je mimo rozsah formátu Kaktusu.");
    return text;
}
function el(name, value, indent) {
    return `${indent}<${name}>${escapeXml(value)}</${name}>\n`;
}
function elIf(name, value, indent) {
    return value === null || value === "" ? "" : el(name, value, indent);
}
function requireFormat(re, value, what) {
    if (!re.test(value))
        throw new Error(`Neplatná hodnota pole ${what} v dávce.`);
    return value;
}
function optionalFormat(re, value, what) {
    return value === null ? null : requireFormat(re, value, what);
}
function buildDokladXml(d) {
    const i1 = "  ";
    const i2 = "    ";
    const i3 = "      ";
    const dod = d.dodavatel;
    let s = `${i1}<FakturaPrijata>\n`;
    s += el("CisloDodavatele", d.cisloDodavatele, i2);
    s += elIf("VarSymbol", d.variabilniSymbol, i2);
    s += `${i2}<Dodavatel>\n`;
    s += el("Nazev", dod.nazev, i3);
    s += elIf("ICO", optionalFormat(format_1.ICO_RE, dod.ico, "ICO"), i3);
    s += elIf("DIC", dod.dic, i3);
    s += elIf("Ulice", dod.ulice, i3);
    s += elIf("Mesto", dod.mesto, i3);
    s += elIf("PSC", dod.psc, i3);
    s += elIf("Stat", dod.stat, i3);
    s += `${i2}</Dodavatel>\n`;
    s += el("DatumVystaveni", requireFormat(format_1.DATE_RE, d.datumVystaveni, "DatumVystaveni"), i2);
    s += elIf("DatumZdanPlneni", optionalFormat(format_1.DATE_RE, d.datumZdanPlneni, "DatumZdanPlneni"), i2);
    s += elIf("DatumSplatnosti", optionalFormat(format_1.DATE_RE, d.datumSplatnosti, "DatumSplatnosti"), i2);
    s += el("Zaklad0", formatCents(d.zaklad0), i2);
    s += el("Zaklad12", formatCents(d.zaklad12), i2);
    s += el("DPH12", formatCents(d.dph12), i2);
    s += el("Zaklad21", formatCents(d.zaklad21), i2);
    s += el("DPH21", formatCents(d.dph21), i2);
    s += el("Celkem", formatCents(d.celkem), i2);
    s += el("Mena", requireFormat(format_1.MENA_RE, d.mena, "Mena"), i2);
    s += elIf("Kurz", optionalFormat(format_1.KURZ_RE, d.kurz, "Kurz"), i2);
    s += el("Text", d.text, i2);
    s += el("Poznamka", d.poznamka, i2);
    s += `${i1}</FakturaPrijata>\n`;
    return s;
}
/**
 * Sestaví dávku pro jednu firmu: Win-1250, bez BOM, deklarace `windows-1250`.
 * Hází `Error` při porušení kontraktu (neplatné ID firmy, prázdná nebo příliš velká dávka);
 * to je chyba programu, ne vstupu.
 */
function buildBatchXml(firma, doklady) {
    if (!read_1.FIRMA_ID_RE.test(firma))
        throw new Error("ID firmy v dávce musí mít 4 číslice.");
    if (doklady.length === 0)
        throw new Error("Dávka nesmí být prázdná.");
    if (doklady.length > exports.MAX_BATCH_SIZE) {
        throw new Error(`Dávka smí mít nejvýše ${exports.MAX_BATCH_SIZE} dokladů (Kaktus by zbytek potichu ignoroval).`);
    }
    let xml = '<?xml version="1.0" encoding="windows-1250"?>\n';
    xml += `<KaktusDavka verze="3.2" firma="${firma}">\n`;
    for (const d of doklady)
        xml += buildDokladXml(d);
    xml += "</KaktusDavka>\n";
    return (0, codec_1.encodeWin1250)(xml);
}
/** Rozdělí doklady jedné firmy na dávky po nejvýše `maxSize` (výchozí a maximální 20). */
function buildBatches(firma, items, maxSize = exports.MAX_BATCH_SIZE) {
    if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > exports.MAX_BATCH_SIZE) {
        throw new Error(`Velikost dávky musí být 1 až ${exports.MAX_BATCH_SIZE}.`);
    }
    const out = [];
    for (let i = 0; i < items.length; i += maxSize) {
        const polozky = items.slice(i, i + maxSize);
        out.push({ firma, polozky, xml: buildBatchXml(firma, polozky.map((p) => p.doklad)) });
    }
    return out;
}
