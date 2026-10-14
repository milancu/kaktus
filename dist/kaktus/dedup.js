"use strict";
// Deduplikace proti stavu Kaktusu (čisté funkce nad načtenými daty, bez I/O).
// Kaktus duplicity nekontroluje, takže je hlídáme my:
//  1. primárně podle značky `TAXY:<id>` v poznámce dokladu;
//  2. záložně (ručně zadané doklady) podle čísla dokladu dodavatele a dodavatele.
//     Dodavatel se určuje takto (shoda je symetrická):
//      - oba mají IČO → musí se shodovat IČO (přes VŠECHNY partnery se stejným IČO);
//      - alespoň jeden IČO nemá → musí se shodovat název (normalizovaný, max. 40 znaků).
//     Kdyby IČO chybělo jen na jedné straně a hledalo se jen podle IČO, ručně zadaný doklad
//     by se nenašel a doklad by se zapsal podruhé. Variabilní symbol se nepoužívá (liší se).
// Smazaný doklad duplicitou není, ale hlásíme ho (varování, resp. u naší značky odmítnutí).
Object.defineProperty(exports, "__esModule", { value: true });
exports.DodavatelDokladRejstrik = void 0;
exports.extractTaxyIds = extractTaxyIds;
exports.normalizeNazev = normalizeNazev;
exports.dokladKey = dokladKey;
exports.buildDedupIndex = buildDedupIndex;
exports.lookupMarker = lookupMarker;
exports.lookupNumber = lookupNumber;
exports.lookupDoklad = lookupDoklad;
const format_1 = require("./format");
const prepare_1 = require("./prepare");
/**
 * Z poznámky vytáhne ID dokladů ze značek `TAXY:<id>`. Porovnává se celé ID (ne předpona),
 * takže `TAXY:doc_1` neodpovídá dokladu `doc_12`.
 */
function extractTaxyIds(poznamka) {
    const ids = [];
    const re = new RegExp(`(?:^|[\\s;,|])${prepare_1.TAXY_PREFIX}([A-Za-z0-9_-]+)`, "g");
    for (let m = re.exec(poznamka); m !== null; m = re.exec(poznamka))
        ids.push(m[1]);
    return ids;
}
/**
 * Normalizace názvu dodavatele pro porovnání: NFC, sloučené mezery, oříznutí na délku pole
 * partnera (40), bez rozlišení velikosti písmen.
 */
function normalizeNazev(nazev) {
    return nazev.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, format_1.FIELD_LIMITS.nazev).trim().toLowerCase();
}
/** Klíč podle IČO: `[ico, číslo]`. */
function icoKey(ico, cislo) {
    return JSON.stringify(["ico", (0, format_1.normalizeIco)(ico), cislo.trim()]);
}
/** Klíč podle názvu: `[název, číslo]`. */
function nazevKey(nazev, cislo) {
    return JSON.stringify(["nazev", normalizeNazev(nazev), cislo.trim()]);
}
/**
 * Klíč „stejný doklad od stejného dodavatele“. S IČO se dodavatel určuje IČO, bez IČO názvem.
 * `cislo` musí být ve stejné podobě jako v DBF (sanitované a ořezané na 20 znaků).
 */
function dokladKey(ico, nazev, cislo) {
    return ico !== null ? icoKey(ico, cislo) : nazevKey(nazev, cislo);
}
/**
 * Rejstřík dokladů podle dodavatele a čísla. Každá položka je uložena pod klíčem podle IČO
 * (má-li je) a pod klíčem podle názvu; hledání pak dodržuje pravidlo „oba IČO → IČO, jinak název“.
 */
class DodavatelDokladRejstrik {
    /** `dokladKey` partnera: s IČO podle IČO, bez IČO podle názvu. */
    podleKlice = new Map();
    /** Všichni partneři podle názvu (i ti s IČO), pro hledání dokladu bez IČO. */
    podleNazvu = new Map();
    static push(map, key, v) {
        const list = map.get(key);
        if (list)
            list.push(v);
        else
            map.set(key, [v]);
    }
    add(ico, nazev, cislo, value) {
        DodavatelDokladRejstrik.push(this.podleKlice, dokladKey(ico, nazev, cislo), value);
        DodavatelDokladRejstrik.push(this.podleNazvu, nazevKey(nazev, cislo), value);
    }
    /** Přesný klíč z `dokladKey` (jen podle IČO, resp. jen podle názvu u partnerů bez IČO). */
    byKey(key) {
        return this.podleKlice.get(key) ?? [];
    }
    /**
     * Shody pro doklad s daným dodavatelem: s IČO podle IČO a navíc podle názvu mezi partnery
     * bez IČO; bez IČO podle názvu přes všechny partnery.
     */
    find(ico, nazev, cislo) {
        if (ico === null)
            return this.podleNazvu.get(nazevKey(nazev, cislo)) ?? [];
        return [...this.byKey(icoKey(ico, cislo)), ...this.byKey(nazevKey(nazev, cislo))];
    }
}
exports.DodavatelDokladRejstrik = DodavatelDokladRejstrik;
function addHit(map, key, f) {
    let h = map.get(key);
    if (!h) {
        h = { zive: [], smazane: [] };
        map.set(key, h);
    }
    (f.smazano ? h.smazane : h.zive).push(f);
}
function toHits(list) {
    return { zive: list.filter((f) => !f.smazano), smazane: list.filter((f) => f.smazano) };
}
/**
 * Sestaví index pro rychlé hledání. Dodavatele záznamu určuje `PARTNER`; partner s příznakem
 * smazání se pro určení IČO/názvu dokladu používá také (nesmazaný doklad je platný doklad,
 * i když někdo smazal jeho partnera) – viz docs/ROZHODNUTI.md.
 */
function buildDedupIndex(data) {
    const partners = new Map();
    for (const p of data.dodavatele)
        partners.set(p.id, p);
    const markers = new Map();
    const cisla = new DodavatelDokladRejstrik();
    for (const f of data.faktury) {
        for (const id of extractTaxyIds(f.poznamka))
            addHit(markers, id, f);
        const partner = f.partnerId === null ? undefined : partners.get(f.partnerId);
        if (partner !== undefined)
            cisla.add(partner.ico, partner.nazev, f.cisloDodavatele, f);
    }
    return { markers, cisla };
}
const NONE = { zive: [], smazane: [] };
function lookupMarker(index, docId) {
    return index.markers.get(docId) ?? NONE;
}
/** Přesné hledání podle klíče z `dokladKey` (bez křížení IČO/název; viz `lookupDoklad`). */
function lookupNumber(index, key) {
    return toHits(index.cisla.byKey(key));
}
/** Záložní shoda pro doklad z TAXY: číslo dokladu dodavatele + dodavatel (IČO, resp. název). */
function lookupDoklad(index, ico, nazev, cislo) {
    return toHits(index.cisla.find(ico, nazev, cislo));
}
