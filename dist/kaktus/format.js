"use strict";
// Formáty a limity polí Kaktusu (ověřeno v kódu simulátoru, ne v příručce).
// Sdílí je validace vstupu z TAXY, příprava hodnot i stavba XML dávky.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FIELD_LIMITS = exports.STAT_RE = exports.MENA_RE = exports.DATE_RE = exports.ICO_RE = exports.KURZ_RE = exports.AMOUNT_OUT_RE = exports.AMOUNT_RE = void 0;
exports.normalizeIco = normalizeIco;
exports.isValidIsoDate = isValidIsoDate;
/** Částka: nejvýše 8 číslic před tečkou, 1–2 desetinná místa (E130). */
exports.AMOUNT_RE = /^-?\d{1,8}(\.\d{1,2})?$/;
/** Částka v tvaru, v jakém ji zapisujeme do XML (vždy dvě desetinná místa). */
exports.AMOUNT_OUT_RE = /^-?\d{1,8}\.\d{2}$/;
/** Kurz: nejvýše 4 číslice před a 4 za tečkou (E230). */
exports.KURZ_RE = /^\d{1,4}(\.\d{1,4})?$/;
/** IČO: 1–8 číslic (E140); pro porovnání se doplňuje nulami na 8. */
exports.ICO_RE = /^\d{1,8}$/;
exports.DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
exports.MENA_RE = /^[A-Z]{3}$/;
exports.STAT_RE = /^[A-Za-z]{2}$/;
/** Délky polí v DBF; delší hodnotu by Kaktus potichu ořízl, proto ořezáváme sami. */
exports.FIELD_LIMITS = {
    nazev: 40, // ADRESAR.NAZEV
    dic: 14, // ADRESAR.DIC
    ulice: 40,
    mesto: 30,
    psc: 6,
    cisloDodavatele: 20, // FAKPRI.CISLODOD
    variabilniSymbol: 10, // FAKPRI.VS
    text: 50, // FAKPRI.TEXT
    poznamka: 60, // FAKPRI.POZN
};
/** Doplní IČO nulami na 8 číslic (v DBF je číselné, úvodní nuly se ztrácejí). */
function normalizeIco(ico) {
    return ico.padStart(8, "0");
}
/** Platné datum ve tvaru RRRR-MM-DD (včetně kontroly kalendáře, jako to dělá Kaktus – E120). */
function isValidIsoDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
        return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
