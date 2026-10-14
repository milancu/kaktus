"use strict";
// Deduplikace proti stavu Kaktusu (čisté funkce nad načtenými daty, bez I/O).
// Kaktus duplicity nekontroluje, takže je hlídáme my:
//  1. primárně podle značky `TAXY:<id>` v poznámce nesmazaného dokladu;
//  2. záložně (ručně zadané doklady) podle čísla dokladu dodavatele a dodavatele –
//     přes VŠECHNY partnery se stejným IČO (v adresáři mohou být duplicitní); dodavatel
//     bez IČO se porovnává podle názvu. Variabilní symbol se nepoužívá (liší se).
// Smazaný doklad duplicitou není, ale hlásíme ho jako varování.
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTaxyIds = extractTaxyIds;
exports.dokladKey = dokladKey;
exports.buildDedupIndex = buildDedupIndex;
exports.lookupMarker = lookupMarker;
exports.lookupNumber = lookupNumber;
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
 * Klíč „stejný doklad od stejného dodavatele“. S IČO se dodavatel určuje IČO, bez IČO názvem.
 * `cislo` musí být ve stejné podobě jako v DBF (sanitované a ořezané na 20 znaků).
 */
function dokladKey(ico, nazev, cislo) {
    return ico !== null
        ? JSON.stringify(["ico", (0, format_1.normalizeIco)(ico), cislo.trim()])
        : JSON.stringify(["nazev", nazev.trim(), cislo.trim()]);
}
function addHit(map, key, f) {
    let h = map.get(key);
    if (!h) {
        h = { zive: [], smazane: [] };
        map.set(key, h);
    }
    (f.smazano ? h.smazane : h.zive).push(f);
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
    const cisla = new Map();
    for (const f of data.faktury) {
        for (const id of extractTaxyIds(f.poznamka))
            addHit(markers, id, f);
        const partner = f.partnerId === null ? undefined : partners.get(f.partnerId);
        if (partner !== undefined)
            addHit(cisla, dokladKey(partner.ico, partner.nazev, f.cisloDodavatele), f);
    }
    return { markers, cisla };
}
const NONE = { zive: [], smazane: [] };
function lookupMarker(index, docId) {
    return index.markers.get(docId) ?? NONE;
}
function lookupNumber(index, key) {
    return index.cisla.get(key) ?? NONE;
}
