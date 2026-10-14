"use strict";
// Převod zvalidovaného dokladu z TAXY na hodnoty polí Kaktusu (čisté funkce bez I/O):
// sanitace znaků, transliterace, ořezy na délky polí DBF, značka `TAXY:<id>` v poznámce
// a varování o všem, co jsme změnili.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TAXY_PREFIX = void 0;
exports.taxyMarker = taxyMarker;
exports.composePoznamka = composePoznamka;
exports.prepareDoklad = prepareDoklad;
const codec_1 = require("../codec");
const format_1 = require("./format");
/** Prefix značky v poznámce dokladu; podle ní poznáváme, co už jsme zapsali (idempotence). */
exports.TAXY_PREFIX = "TAXY:";
/** Značka dokladu v poznámce, např. `TAXY:doc_00a5091cef`. */
function taxyMarker(docId) {
    return `${exports.TAXY_PREFIX}${docId}`;
}
/**
 * Poznámka dokladu: značka `TAXY:<id>` je na začátku a ořezem se nikdy neztratí – případný
 * další text se ořízne tak, aby se vešel do zbývajícího místa (limit 60 znaků).
 * ID dokladu je omezeno na 40 znaků (viz `DOC_ID_RE`), značka se tedy vždy vejde.
 */
function composePoznamka(docId, extra) {
    const marker = taxyMarker(docId);
    if (marker.length > format_1.FIELD_LIMITS.poznamka) {
        throw new Error("ID dokladu je příliš dlouhé pro značku v poznámce.");
    }
    const room = format_1.FIELD_LIMITS.poznamka - marker.length - 1;
    if (extra === undefined || extra === null || extra.trim() === "" || room < 1) {
        return { text: marker, warnings: [] };
    }
    const s = (0, codec_1.sanitizeField)(extra, "Poznámka", room);
    return { text: s.text === "" ? marker : `${marker} ${s.text}`, warnings: s.warnings };
}
/** Připraví hodnoty polí; prázdné povinné pole (po sanitaci) je důvod k odmítnutí dokladu. */
function prepareDoklad(d) {
    const varovani = [...d.varovani];
    const take = (value, label, max) => {
        const s = (0, codec_1.sanitizeField)(value ?? "", label, max);
        varovani.push(...s.warnings);
        return s.text;
    };
    const cisloDodavatele = take(d.cisloDokladu, "Číslo dokladu dodavatele", format_1.FIELD_LIMITS.cisloDodavatele);
    const nazev = take(d.dodavatel.nazev, "Název dodavatele", format_1.FIELD_LIMITS.nazev);
    if (cisloDodavatele === "")
        return { ok: false, duvod: "Číslo dokladu je po úpravě znaků prázdné." };
    if (nazev === "")
        return { ok: false, duvod: "Název dodavatele je po úpravě znaků prázdný." };
    const dic = take(d.dodavatel.dic, "DIČ dodavatele", format_1.FIELD_LIMITS.dic);
    const poznamka = composePoznamka(d.id);
    varovani.push(...poznamka.warnings);
    if (dic === "" && (d.dph12 !== 0 || d.dph21 !== 0)) {
        varovani.push("Dodavatel nemá DIČ, ale doklad účtuje DPH.");
    }
    const doklad = {
        cisloDodavatele,
        variabilniSymbol: take(d.variabilniSymbol, "Variabilní symbol", format_1.FIELD_LIMITS.variabilniSymbol),
        dodavatel: {
            nazev,
            ico: d.dodavatel.ico,
            dic,
            ulice: take(d.dodavatel.ulice, "Ulice dodavatele", format_1.FIELD_LIMITS.ulice),
            mesto: take(d.dodavatel.mesto, "Město dodavatele", format_1.FIELD_LIMITS.mesto),
            psc: take(d.dodavatel.psc, "PSČ dodavatele", format_1.FIELD_LIMITS.psc),
            stat: d.dodavatel.stat ?? "",
        },
        datumVystaveni: d.datumVystaveni,
        datumZdanPlneni: d.duzp,
        datumSplatnosti: d.datumSplatnosti,
        zaklad0: d.zaklad0,
        zaklad12: d.zaklad12,
        dph12: d.dph12,
        zaklad21: d.zaklad21,
        dph21: d.dph21,
        celkem: d.celkem,
        mena: d.mena,
        kurz: d.kurz,
        text: take(d.popis, "Text dokladu", format_1.FIELD_LIMITS.text),
        poznamka: poznamka.text,
    };
    return { ok: true, doklad, varovani };
}
