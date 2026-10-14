"use strict";
// Plánovací část zápisu – čisté funkce bez I/O.
// Pořadí kroků pro každý doklad: identita → autorizace klient→firma → plná validace →
// příprava hodnot (sanitace, ořezy) → deduplikace → zařazení k zápisu.
// Samotné spuštění importu, dávky po 20 a ověření výsledku řeší navazující kód (write.ts).
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeKlient = authorizeKlient;
exports.planWrite = planWrite;
const dedup_1 = require("./kaktus/dedup");
const read_1 = require("./kaktus/read");
const prepare_1 = require("./kaktus/prepare");
const input_1 = require("./taxy/input");
/**
 * Autorizace klient → firma (ochrana proti IDOR). Doklad smí do firmy jen tehdy, když:
 *  - `klientId` je v seznamu klientů právě jednou,
 *  - jeho `kaktusFirma` má platný tvar a existuje (nesmazaná) ve FIRMY.DBF,
 *  - IČO odběratele z dokladu == IČO klienta == IČO firmy ve FIRMY.DBF.
 * Firmu určuje výhradně tato funkce z konfigurace klientů; z obsahu dokladu se nikdy nebere.
 * Při jakémkoli nesouladu se odmítá, nic se nehádá.
 */
function authorizeKlient(klientId, odberatelIco, klienti, firmyData) {
    const shody = klienti.filter((k) => k.klientId === klientId);
    if (shody.length === 0)
        return { ok: false, duvod: `Klient ${klientId} není v seznamu klientů.` };
    const klient = shody[0];
    if (shody.length > 1)
        return { ok: false, duvod: `Klient ${klientId} je v seznamu klientů vícekrát.` };
    if (!read_1.FIRMA_ID_RE.test(klient.kaktusFirma)) {
        return { ok: false, duvod: `Klient ${klientId} má neplatné přiřazení k firmě v Kaktusu.` };
    }
    const data = firmyData.get(klient.kaktusFirma);
    if (data === undefined || data.firma.id !== klient.kaktusFirma || data.firma.smazano) {
        return { ok: false, duvod: `Firma ${klient.kaktusFirma} klienta ${klientId} v Kaktusu neexistuje.` };
    }
    if (data.firma.ico === null) {
        return { ok: false, duvod: `Firma ${klient.kaktusFirma} nemá v Kaktusu vyplněné IČO.` };
    }
    if (klient.ico !== data.firma.ico) {
        return { ok: false, duvod: `IČO klienta ${klientId} se neshoduje s IČO firmy ${klient.kaktusFirma} v Kaktusu.` };
    }
    if (odberatelIco !== klient.ico) {
        return { ok: false, duvod: `IČO odběratele na dokladu se neshoduje s IČO klienta ${klientId}; doklad nepatří této firmě.` };
    }
    return { ok: true, klient, firma: data.firma };
}
/**
 * Naplánuje zápis. `rawDoklady` jsou doklady přímo z JSONu (každý se validuje zvlášť),
 * `firmyData` jsou aktuální data firem z Kaktusu (klíč = ID firmy) – FIRMY, ADRESAR, FAKPRI.
 * Firma, která v mapě chybí, se považuje za neexistující.
 */
function planWrite(klienti, rawDoklady, firmyData) {
    const vysledky = [];
    const perFirma = new Map();
    const indexy = new Map();
    const videnaId = new Set();
    /** firma + klíč dokladu → ID prvního dokladu s tímto klíčem (duplicita ve vstupu). */
    const videneKlice = new Map();
    const indexFor = (firma, data) => {
        let idx = indexy.get(firma);
        if (!idx) {
            idx = (0, dedup_1.buildDedupIndex)(data);
            indexy.set(firma, idx);
        }
        return idx;
    };
    rawDoklady.forEach((raw, index) => {
        const odmitnout = (id, klientId, firma, duvod, varovani = []) => {
            vysledky.push({ index, id, klientId, firma, stav: "odmitnuto", duvod, varovani });
        };
        // 1. Identita (id, klientId, IČO odběratele) – nutná k autorizaci.
        const ident = (0, input_1.parseIdentita)(raw);
        if (!ident.ok) {
            odmitnout(ident.id, ident.klientId, null, ident.duvody.join(" "));
            return;
        }
        const { id, klientId, odberatelIco } = ident.identita;
        if (videnaId.has(id)) {
            odmitnout(id, klientId, null, "Duplicitní „id“ dokladu ve vstupu.");
            return;
        }
        videnaId.add(id);
        // 2. Autorizace – bez ní se doklad dál nezpracovává.
        const auth = authorizeKlient(klientId, odberatelIco, klienti, firmyData);
        if (!auth.ok) {
            odmitnout(id, klientId, null, auth.duvod);
            return;
        }
        const firmaId = auth.firma.id;
        // 3. Plná validace.
        const parsed = (0, input_1.parseDoklad)(raw);
        if (!parsed.ok) {
            odmitnout(id, klientId, firmaId, parsed.duvody.join(" "));
            return;
        }
        // 4. Příprava hodnot polí (sanitace, ořezy, varování).
        const prep = (0, prepare_1.prepareDoklad)(parsed.doklad);
        if (!prep.ok) {
            odmitnout(id, klientId, firmaId, prep.duvod);
            return;
        }
        const varovani = prep.varovani;
        const bd = prep.doklad;
        // 5. Deduplikace.
        const data = firmyData.get(firmaId); // existence ověřila autorizace
        const idx = indexFor(firmaId, data);
        const key = (0, dedup_1.dokladKey)(bd.dodavatel.ico, bd.dodavatel.nazev, bd.cisloDodavatele);
        const vstupKey = `${firmaId}\u0000${key}`;
        const markerHits = (0, dedup_1.lookupMarker)(idx, id);
        const hotovo = markerHits.zive[0];
        if (hotovo !== undefined) {
            if (!videneKlice.has(vstupKey))
                videneKlice.set(vstupKey, id);
            vysledky.push({
                index, id, klientId, firma: firmaId, stav: "jiz_zapsano", kaktusDoklad: hotovo.doklad, varovani,
            });
            return;
        }
        const predchozi = videneKlice.get(vstupKey);
        if (predchozi !== undefined) {
            odmitnout(id, klientId, firmaId, `Duplicita ve vstupu: stejný dodavatel a číslo dokladu jako doklad ${predchozi}.`, varovani);
            return;
        }
        videneKlice.set(vstupKey, id);
        const cisloHits = (0, dedup_1.lookupNumber)(idx, key);
        const rucne = cisloHits.zive[0];
        if (rucne !== undefined) {
            vysledky.push({
                index, id, klientId, firma: firmaId, stav: "jiz_zapsano", kaktusDoklad: rucne.doklad,
                varovani: [
                    ...varovani,
                    `Doklad už v Kaktusu je (${rucne.doklad}, shoda podle čísla dokladu dodavatele a dodavatele, ne podle značky TAXY).`,
                ],
            });
            return;
        }
        const smazane = [...markerHits.smazane, ...cisloHits.smazane];
        if (smazane.length > 0) {
            const cisla = [...new Set(smazane.map((f) => f.doklad))].join(", ");
            varovani.push(`V Kaktusu existuje smazaný doklad se stejným číslem dodavatele (${cisla}); doklad se přesto zapíše.`);
        }
        // 6. K zápisu.
        let pf = perFirma.get(firmaId);
        if (!pf) {
            pf = { firma: auth.firma, kZapisu: [] };
            perFirma.set(firmaId, pf);
        }
        pf.kZapisu.push({ index, id, klientId, doklad: bd, varovani });
        vysledky.push({ index, id, klientId, firma: firmaId, stav: "k_zapisu", varovani });
    });
    return { perFirma, vysledky };
}
