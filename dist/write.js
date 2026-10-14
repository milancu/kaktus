"use strict";
// Orchestrace zápisu: načtení dat firem → plán (autorizace, validace, deduplikace) →
// pro každou firmu po dávkách: čerstvé načtení FAKPRI + přeplánování → import → ověření podle DBF.
//
// Pravda je vždy DBF: po každé dávce (i po pádu nebo chybějící odpovědi) se FAKPRI načte znovu
// a výsledek každého dokladu se určí podle značky `TAXY:<id>`. Odpověď Kaktusu je jen nápověda
// (kód a text chyby, kontrola rozporů).
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
exports.STAVY = void 0;
exports.overVelikostDavky = overVelikostDavky;
exports.prazdnePocty = prazdnePocty;
exports.sestavSouhrn = sestavSouhrn;
exports.reconcileDavka = reconcileDavka;
exports.loadFirmyData = loadFirmyData;
exports.vyresOdlozene = vyresOdlozene;
exports.zapis = zapis;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const errors_1 = require("./errors");
const batch_1 = require("./kaktus/batch");
const dedup_1 = require("./kaktus/dedup");
const import_1 = require("./kaktus/import");
const read_1 = require("./kaktus/read");
const plan_1 = require("./plan");
exports.STAVY = [
    "zapsano", "jiz_zapsano", "odmitnuto", "chyba_kaktusu", "neprovedeno", "k_zapisu",
];
/** Ověří velikost dávky (celé číslo 1–20; Kaktus zpracuje jen prvních 20 dokladů). */
function overVelikostDavky(velikost) {
    if (velikost === undefined)
        return batch_1.MAX_BATCH_SIZE;
    if (!Number.isInteger(velikost) || velikost < 1 || velikost > batch_1.MAX_BATCH_SIZE) {
        throw new errors_1.VstupniChyba(`Velikost dávky musí být celé číslo od 1 do ${batch_1.MAX_BATCH_SIZE}.`);
    }
    return velikost;
}
function prazdnePocty() {
    return { zapsano: 0, jiz_zapsano: 0, odmitnuto: 0, chyba_kaktusu: 0, neprovedeno: 0, k_zapisu: 0 };
}
/** Souhrn podle stavů, celkem i po firmách (doklady bez firmy jsou jen v celkovém součtu). */
function sestavSouhrn(doklady, prerusene) {
    const pocty = prazdnePocty();
    const byFirma = new Map();
    for (const d of doklady) {
        pocty[d.stav]++;
        if (d.firma !== null) {
            let f = byFirma.get(d.firma);
            if (!f) {
                f = { pocty: prazdnePocty() };
                byFirma.set(d.firma, f);
            }
            f.pocty[d.stav]++;
        }
    }
    const firmy = {};
    for (const k of [...byFirma.keys()].sort()) {
        const f = byFirma.get(k);
        const duvod = prerusene.get(k);
        firmy[k] = duvod === undefined ? f : { pocty: f.pocty, preruseno: duvod };
    }
    return { celkem: doklady.length, pocty, firmy };
}
/** Důvod, proč se import nezdařil; null = import doběhl (exit 0). */
function duvodSelhani(firma, imp) {
    if (imp === null)
        return `Firmu ${firma} se nepodařilo ověřit; import nebyl spuštěn.`;
    switch (imp.stav) {
        case "zpracovano": return null;
        case "firma_zamcena": return `Firma ${firma} je v Kaktusu otevřená (zámek FIRMA.LCK); doklad nebyl zapsán, zkuste znovu po jejím zavření.`;
        case "firma_neexistuje": return `Kaktus hlásí, že firma ${firma} neexistuje; doklad nebyl zapsán.`;
        case "davka_necitelna": return "Kaktus dávku nepřečetl (nic nezapsal); doklad nebyl zapsán.";
        case "pad": return `Import se nedokončil (${imp.detail ?? "pád"}); doklad nebyl zapsán, zkuste znovu.`;
    }
}
/**
 * Určí výsledek každé položky dávky podle čerstvě načtených dat (`fresh`) a výsledku importu.
 * `polozky[i]` odpovídá v odpovědi `poradi = i + 1`. Pravdu má DBF; rozpor s odpovědí je varování.
 *  - značka `TAXY:<id>` v nesmazaném dokladu → `zapsano` (s číslem dokladu z DBF);
 *  - jinak odpověď s kódem chyby → `chyba_kaktusu`;
 *  - jinak (zámek, pád, chybějící odpověď, rozpor) → `neprovedeno`.
 */
function reconcileDavka(firma, polozky, fresh, imp) {
    const idx = (0, dedup_1.buildDedupIndex)(fresh);
    const selhani = duvodSelhani(firma, imp);
    return polozky.map((p, i) => {
        const varovani = [];
        const resp = imp?.odpoved?.doklady.get(i + 1);
        const zive = (0, dedup_1.lookupMarker)(idx, p.id).zive;
        const nalez = zive[0];
        if (nalez !== undefined) {
            if (zive.length > 1) {
                varovani.push(`Značka dokladu je v Kaktusu u více dokladů (${zive.map((f) => f.doklad).join(", ")}); zkontrolujte duplicitu.`);
            }
            if (resp?.stav === "CHYBA") {
                varovani.push(`Odpověď Kaktusu hlásí chybu ${resp.kod ?? ""}, ale doklad je v databázi; platí databáze.`);
            }
            else if (resp?.stav === "OK" && resp.doklad !== nalez.doklad) {
                varovani.push(`Odpověď Kaktusu uvádí doklad ${resp.doklad ?? ""}, v databázi je ${nalez.doklad}; platí databáze.`);
            }
            return { stav: "zapsano", kaktusDoklad: nalez.doklad, varovani };
        }
        if (resp?.stav === "CHYBA") {
            return { stav: "chyba_kaktusu", kod: resp.kod, duvod: resp.zprava ?? "", varovani };
        }
        if (resp?.stav === "OK") {
            varovani.push(`Odpověď Kaktusu hlásí zápis (${resp.doklad ?? ""}), ale doklad v databázi není; platí databáze.`);
            return { stav: "neprovedeno", duvod: "Zápis se nepodařilo ověřit v databázi Kaktusu; zkuste znovu.", varovani };
        }
        let duvod = selhani ?? "Odpověď Kaktusu neobsahuje výsledek dokladu a doklad v databázi není; zkuste znovu.";
        if (selhani === null && imp?.odpovedChyba !== undefined)
            duvod = "Odpověď Kaktusu nelze použít a doklad v databázi není; zkuste znovu.";
        return { stav: "neprovedeno", duvod, varovani };
    });
}
// ---------------------------------------------------------------------------
// Orchestrace
// ---------------------------------------------------------------------------
function isLocked(firmaDir) {
    return fs.existsSync(path.join(firmaDir, "FIRMA.LCK"));
}
/**
 * Načte data firem, na které se odkazují klienti. Neexistující nebo smazaná firma se do mapy
 * nedostane (autorizace pak doklady odmítne). Nečitelná data existující firmy = `VstupniChyba`
 * (nic se nezapíše; nečitelnou firmu nelze zaměnit za „neexistující“).
 */
function loadFirmyData(kaktusDir, klienti) {
    const existujici = new Set((0, read_1.readFirmy)(kaktusDir).filter((f) => !f.smazano).map((f) => f.id));
    const out = new Map();
    for (const k of klienti) {
        const id = k.kaktusFirma;
        if (!read_1.FIRMA_ID_RE.test(id) || !existujici.has(id) || out.has(id))
            continue;
        try {
            out.set(id, (0, read_1.readFirmaData)(kaktusDir, id));
        }
        catch (e) {
            if (e instanceof errors_1.VstupniChyba)
                throw new errors_1.VstupniChyba(`Data firmy ${id} nelze načíst: ${e.message}`);
            throw e;
        }
    }
    return out;
}
/** Řádek reportu s pevným pořadím klíčů (deterministický výstup). */
function uporadej(r) {
    const out = { id: r.id, klientId: r.klientId, firma: r.firma, stav: r.stav };
    if (r.kaktusDoklad !== undefined)
        out.kaktusDoklad = r.kaktusDoklad;
    if (r.kod !== undefined)
        out.kod = r.kod;
    if (r.duvod !== undefined)
        out.duvod = r.duvod;
    out.varovani = r.varovani;
    return out;
}
function nastav(radek, v) {
    radek.stav = v.stav;
    delete radek.kaktusDoklad;
    delete radek.kod;
    delete radek.duvod;
    if (v.kaktusDoklad !== undefined)
        radek.kaktusDoklad = v.kaktusDoklad;
    if (v.kod !== undefined)
        radek.kod = v.kod;
    if (v.duvod !== undefined)
        radek.duvod = v.duvod;
    if (v.varovani !== undefined)
        radek.varovani = [...v.varovani];
}
function neprovedeno(ctx, polozky, duvod) {
    for (const p of polozky)
        nastav(ctx.report[p.index], { stav: "neprovedeno", duvod });
}
/** Zapíše výsledky ověření dávky do reportu; vrací true, pokud je některý doklad `neprovedeno`. */
function aplikujVysledky(ctx, polozky, vysledky) {
    let nejasne = false;
    vysledky.forEach((v, i) => {
        const radek = ctx.report[polozky[i].index];
        nastav(radek, { ...v, varovani: [...radek.varovani, ...v.varovani] });
        if (v.stav === "neprovedeno")
            nejasne = true;
    });
    return nejasne;
}
async function zpracujFirmu(ctx, firmaId, kZapisu) {
    const { opts } = ctx;
    const velikost = overVelikostDavky(opts.maxDavka);
    let zbyva = [...kZapisu];
    const prerus = (duvod, polozky) => {
        ctx.prerusene.set(firmaId, duvod);
        neprovedeno(ctx, polozky, duvod);
    };
    while (zbyva.length > 0) {
        const slice = zbyva.slice(0, velikost);
        zbyva = zbyva.slice(velikost);
        // 1. Čerstvá data firmy a přeplánování dávky (idempotence i mezi dávkami).
        let fresh;
        let firmaDir;
        try {
            fresh = (0, read_1.readFirmaData)(opts.kaktusDir, firmaId);
            firmaDir = (0, read_1.resolveFirmaDir)(opts.kaktusDir, fresh.firma);
        }
        catch (e) {
            const d = `Data firmy ${firmaId} nelze načíst${e instanceof Error ? `: ${e.message}` : "."}`;
            prerus(d, [...slice, ...zbyva]);
            return;
        }
        const replan = (0, plan_1.planWrite)(opts.klienti, slice.map((p) => opts.doklady[p.index]), new Map([[firmaId, fresh]]));
        for (const v of replan.vysledky) {
            if (v.stav === "k_zapisu")
                continue;
            const radek = ctx.report[slice[v.index].index];
            nastav(radek, { stav: v.stav, kaktusDoklad: v.kaktusDoklad, duvod: v.duvod, varovani: v.varovani });
        }
        const items = (replan.perFirma.get(firmaId)?.kZapisu ?? []).map((p) => {
            const puvodni = slice[p.index];
            ctx.report[puvodni.index].varovani = [...p.varovani];
            return { ...p, index: puvodni.index };
        });
        if (items.length === 0)
            continue;
        // 2. Předběžná kontrola zámku (Kaktus ji dělá jen na začátku importu, viz i exit 3).
        if (isLocked(firmaDir)) {
            prerus(`Firma ${firmaId} je v Kaktusu otevřená (zámek FIRMA.LCK); doklady nebyly zapsány, zkuste znovu po jejím zavření.`, [...items, ...zbyva]);
            return;
        }
        // 3. Dávka → import → ověření podle DBF.
        const davka = (0, batch_1.buildBatches)(firmaId, items, batch_1.MAX_BATCH_SIZE)[0];
        if (davka === undefined)
            continue;
        ctx.rozpracovana = { firmaId, polozky: davka.polozky };
        const imp = await (0, import_1.importDavka)(opts.kaktusDir, davka.xml, {
            firma: firmaId, pocet: davka.polozky.length, timeoutMs: opts.timeoutMs, runner: opts.runner, tmpRoot: opts.tmpRoot,
        });
        let po;
        try {
            po = (0, read_1.readFirmaData)(opts.kaktusDir, firmaId);
        }
        catch {
            ctx.rozpracovana = null;
            prerus(`Po importu se nepodařilo načíst data firmy ${firmaId}; výsledek nelze ověřit, zkuste znovu (zápis je idempotentní).`, [...davka.polozky, ...zbyva]);
            return;
        }
        const nejasne = aplikujVysledky(ctx, davka.polozky, reconcileDavka(firmaId, davka.polozky, po, imp));
        ctx.rozpracovana = null;
        if (imp.stav !== "zpracovano" || nejasne) {
            // Zámek, pád nebo neověřený doklad: další dávky téže firmy nezkoušíme (bezpečné spustit znovu).
            const d = duvodSelhani(firmaId, imp) ?? `Výsledek některých dokladů firmy ${firmaId} se nepodařilo ověřit.`;
            prerus(d, zbyva);
            return;
        }
    }
}
/**
 * Nečekaná výjimka uvnitř firmy (např. selhání úklidu, I/O). Import už mohl doběhnout, takže
 * rozpracovanou dávku ověříme podle čerstvě načteného FAKPRI (DBF je pravda); jen když se ani
 * to nepodaří, zůstanou její doklady `neprovedeno` (přes pojistku v `zapis`).
 */
function zpracujVyjimku(ctx, firmaId, e) {
    ctx.prerusene.set(firmaId, `Nečekaná chyba při zpracování firmy ${firmaId}${e instanceof Error ? `: ${e.message}` : "."}`);
    const r = ctx.rozpracovana;
    ctx.rozpracovana = null;
    if (r === null || r.firmaId !== firmaId)
        return;
    const cekajici = r.polozky.filter((p) => ctx.report[p.index].stav === "k_zapisu");
    if (cekajici.length === 0)
        return;
    try {
        const po = (0, read_1.readFirmaData)(ctx.opts.kaktusDir, firmaId);
        const imp = { stav: "pad", exitCode: null, odpoved: null, detail: "Nečekaná chyba po spuštění importu" };
        aplikujVysledky(ctx, cekajici, reconcileDavka(firmaId, cekajici, po, imp));
    }
    catch {
        // data nelze načíst → doklady zůstanou k_zapisu a pojistka je označí `neprovedeno`
    }
}
async function zpracujPlan(ctx, perFirma) {
    for (const [firmaId, pf] of perFirma) {
        try {
            await zpracujFirmu(ctx, firmaId, pf.kZapisu);
        }
        catch (e) {
            zpracujVyjimku(ctx, firmaId, e);
        }
    }
}
/**
 * Rozhodne o duplicitách ve vstupu podle výsledku jejich prvního výskytu (`odlozene`: index →
 * ID prvního dokladu). Vrací indexy dokladů, které je třeba přeplánovat (první výskyt skončil
 * `chyba_kaktusu`/`odmitnuto`, takže se další výskyt zkusí zapsat); ostatní řádky upraví:
 *  - první je `zapsano`/`jiz_zapsano` → zůstává `odmitnuto` (duplicita), s odkazem na skutečný doklad;
 *  - první je `neprovedeno` (nebo jeho firma byla přerušena) → také `neprovedeno` (nezapisovat oba).
 * Zpracované položky z `odlozene` odstraní.
 */
function vyresOdlozene(report, odlozene, prerusene) {
    const podleId = new Map();
    for (const r of report)
        if (r.id !== null && !podleId.has(r.id))
            podleId.set(r.id, r);
    const uvolnit = [];
    for (const index of [...odlozene.keys()].sort((a, b) => a - b)) {
        const predId = odlozene.get(index);
        odlozene.delete(index);
        const radek = report[index];
        const pred = podleId.get(predId);
        if (pred !== undefined && (pred.stav === "zapsano" || pred.stav === "jiz_zapsano")) {
            const kde = pred.kaktusDoklad !== undefined ? ` jako ${pred.kaktusDoklad}` : "";
            radek.duvod = `Duplicita ve vstupu: stejný dodavatel a číslo dokladu jako doklad ${predId}, který je v Kaktusu${kde}.`;
            continue;
        }
        const firmaPreruseni = radek.firma === null ? undefined : prerusene.get(radek.firma);
        if (pred !== undefined && (pred.stav === "chyba_kaktusu" || pred.stav === "odmitnuto") && firmaPreruseni === undefined) {
            uvolnit.push(index);
            continue;
        }
        nastav(radek, {
            stav: "neprovedeno",
            duvod: firmaPreruseni ?? `Výsledek dokladu ${predId} (stejný dodavatel a číslo dokladu) není znám; doklad se nezapisuje, zkuste znovu.`,
        });
    }
    return uvolnit;
}
/**
 * Po zpracování prvních výskytů přeplánuje odložené duplicity (viz `vyresOdlozene`) proti čerstvým
 * datům Kaktusu a zapíše ty, které už nejsou duplicitou. Opakuje, dokud je co rozhodovat.
 */
async function zpracujOdlozene(ctx, odlozene) {
    const { opts, report } = ctx;
    for (let kolo = 0; odlozene.size > 0 && kolo <= opts.doklady.length; kolo++) {
        const uvolnit = vyresOdlozene(report, odlozene, ctx.prerusene);
        if (uvolnit.length === 0)
            return;
        const firmyData = new Map();
        const planovat = [];
        for (const index of uvolnit) {
            const radek = report[index];
            const firmaId = radek.firma; // duplicita se řeší až po autorizaci, firma je vždy vyplněna
            if (!firmyData.has(firmaId) && !ctx.prerusene.has(firmaId)) {
                try {
                    firmyData.set(firmaId, (0, read_1.readFirmaData)(opts.kaktusDir, firmaId));
                }
                catch (e) {
                    ctx.prerusene.set(firmaId, `Data firmy ${firmaId} nelze načíst${e instanceof Error ? `: ${e.message}` : "."}`);
                }
            }
            if (firmyData.has(firmaId))
                planovat.push(index);
            else
                nastav(radek, { stav: "neprovedeno", duvod: ctx.prerusene.get(firmaId) ?? "Data firmy nelze načíst." });
        }
        if (planovat.length === 0)
            return;
        const plan = (0, plan_1.planWrite)(opts.klienti, planovat.map((i) => opts.doklady[i]), firmyData);
        for (const v of plan.vysledky) {
            const puvodni = planovat[v.index];
            nastav(report[puvodni], { stav: v.stav, kaktusDoklad: v.kaktusDoklad, duvod: v.duvod, varovani: v.varovani });
            if (v.odlozitNa !== undefined)
                odlozene.set(puvodni, v.odlozitNa);
        }
        const perFirma = new Map();
        for (const [firmaId, pf] of plan.perFirma) {
            perFirma.set(firmaId, { kZapisu: pf.kZapisu.map((p) => ({ ...p, index: planovat[p.index] })) });
        }
        await zpracujPlan(ctx, perFirma);
    }
}
/**
 * Provede zápis (nebo jeho plán při `dryRun`). Nikdy nehází kvůli pádu importu ani kvůli
 * nečekané chybě uvnitř jedné firmy (její zbylé doklady jsou `neprovedeno`); `VstupniChyba`
 * vyhazuje jen před jakýmkoli zápisem (nečitelná data, chybějící kaktus.cjs, neplatná velikost dávky).
 */
async function zapis(opts) {
    overVelikostDavky(opts.maxDavka);
    const dryRun = opts.dryRun === true;
    if (!dryRun)
        (0, import_1.resolveKaktusScript)(opts.kaktusDir);
    const firmyData = loadFirmyData(opts.kaktusDir, opts.klienti);
    const plan = (0, plan_1.planWrite)(opts.klienti, opts.doklady, firmyData);
    const report = plan.vysledky.map((v) => {
        const r = { id: v.id, klientId: v.klientId, firma: v.firma, stav: v.stav, varovani: [...v.varovani] };
        if (v.kaktusDoklad !== undefined)
            r.kaktusDoklad = v.kaktusDoklad;
        if (v.duvod !== undefined)
            r.duvod = v.duvod;
        return r;
    });
    const prerusene = new Map();
    if (!dryRun) {
        const ctx = { opts, report, prerusene, rozpracovana: null };
        // Duplicity ve vstupu se rozhodnou až podle výsledku prvního výskytu (např. E220 u prvního).
        const odlozene = new Map();
        for (const v of plan.vysledky)
            if (v.odlozitNa !== undefined)
                odlozene.set(v.index, v.odlozitNa);
        await zpracujPlan(ctx, plan.perFirma);
        await zpracujOdlozene(ctx, odlozene);
        // Pojistka: doklad, který zůstal ve stavu „k zápisu“, nebyl zpracován.
        for (const r of report) {
            if (r.stav === "k_zapisu") {
                const d = r.firma === null ? undefined : prerusene.get(r.firma);
                nastav(r, { stav: "neprovedeno", duvod: d ?? "Doklad nebyl zpracován; zkuste znovu." });
            }
        }
    }
    const doklady = report.map(uporadej);
    return { format: 1, rezim: dryRun ? "dry-run" : "zapis", souhrn: sestavSouhrn(doklady, prerusene), doklady };
}
