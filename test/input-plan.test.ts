// Validace vstupu z TAXY (nedůvěryhodný), autorizace, plánování a deduplikace – čisté funkce.
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  amountToCents, kurzToString, loadDoklady, loadKlienti, MAX_DOKLADU, MAX_DOKLADY_BYTES, MAX_KLIENTI_BYTES,
  parseDoklad, parseDokladyFile, parseJsonBuffer, parseKlienti,
} from "../src/taxy/input";
import type { Klient } from "../src/taxy/input";
import { authorizeKlient, planWrite } from "../src/plan";
import { buildDedupIndex, dokladKey, extractTaxyIds, lookupMarker, lookupNumber } from "../src/kaktus/dedup";
import type { Dodavatel, FakturaPrijata, Firma, FirmaData } from "../src/kaktus/read";
import { VstupniChyba } from "../src/errors";
import { mkDoklad } from "./helpers";

const klienti: Klient[] = [
  { klientId: 4172, nazev: "Truhlářství", ico: "90412761", kaktusFirma: "0001" },
  { klientId: 4180, nazev: "Pekařství", ico: "90581130", kaktusFirma: "0002" },
];

function firma(id: string, ico: string | null, smazano = false): Firma {
  return { id, nazev: `F${id}`, ico, dic: null, slozka: id, platceDph: true, smazano };
}
function dod(id: number, ico: string | null, nazev: string, smazano = false): Dodavatel {
  return { id, nazev, ico, dic: null, ulice: "", mesto: "", psc: "", stat: "CZ", ucet: "", poznamka: "", smazano };
}
function fak(id: number, partnerId: number | null, cislo: string, poznamka = "", smazano = false): FakturaPrijata {
  return {
    id, doklad: `FP26${String(id).padStart(4, "0")}`, cisloDodavatele: cislo, variabilniSymbol: "", partnerId,
    datumVystaveni: "2026-10-01", datumZdanitelnehoPlneni: null, datumSplatnosti: null, datumUhrady: null,
    zaklad0: 0, zaklad12: 0, dph12: 0, zaklad21: 0, dph21: 0, celkem: 0, mena: "CZK", kurz: 1, text: "", poznamka, smazano,
  };
}
function fd(f: Firma, dodavatele: Dodavatel[] = [], faktury: FakturaPrijata[] = []): FirmaData {
  return { firma: f, dodavatele, faktury };
}
const mapa = (...x: FirmaData[]): Map<string, FirmaData> => new Map(x.map((d) => [d.firma.id, d]));

describe("parseDoklad – striktní validace nedůvěryhodného vstupu", () => {
  const odmitni = (popis: string, over: Record<string, unknown>) =>
    it(`odmítne: ${popis}`, () => {
      const r = parseDoklad(mkDoklad("v1", over));
      assert.equal(r.ok, false, popis);
    });

  it("platný doklad projde, částky jsou v haléřích", () => {
    const r = parseDoklad(mkDoklad("ok", { rozpisDph: [{ sazba: 21, zaklad: 2017, dph: 423.57 }], celkem: 2441 }));
    assert.ok(r.ok);
    assert.equal(r.doklad.zaklad21, 201700);
    assert.equal(r.doklad.dph21, 42357);
    assert.equal(r.doklad.celkem, 244100);
    assert.equal(r.doklad.odberatelIco, "90412761");
  });

  odmitni("typ jiný než faktura_prijata", { typ: "faktura_vydana" });
  odmitni("stav jiný než schvaleno", { stav: "ke_schvaleni" });
  odmitni("cisloDokladu null", { cisloDokladu: null });
  odmitni("cisloDokladu prázdné", { cisloDokladu: "   " });
  odmitni("cisloDokladu číslo", { cisloDokladu: 123 });
  odmitni("klientId jako text", { klientId: "4172" });
  odmitni("klientId desetinné", { klientId: 4172.5 });
  odmitni("částka jako text", { celkem: "121" });
  odmitni("částka s třemi desetinnými místy", { rozpisDph: [{ sazba: 21, zaklad: 100.123, dph: 21 }] });
  odmitni("částka s 9 číslicemi", { rozpisDph: [{ sazba: 21, zaklad: 123456789, dph: 21 }], celkem: 123456810 });
  odmitni("částka v exponenciálním zápisu", { rozpisDph: [{ sazba: 21, zaklad: 1e21, dph: 21 }] });
  odmitni("sazba 15 %", { rozpisDph: [{ sazba: 15, zaklad: 100, dph: 15 }] });
  odmitni("sazba dvakrát", { rozpisDph: [{ sazba: 21, zaklad: 100, dph: 21 }, { sazba: 21, zaklad: 1, dph: 0.21 }] });
  odmitni("rozpis prázdný", { rozpisDph: [] });
  odmitni("rozpis 4 položky", { rozpisDph: [{ sazba: 0, zaklad: 1, dph: 0 }, { sazba: 12, zaklad: 1, dph: 0 }, { sazba: 21, zaklad: 1, dph: 0 }, { sazba: 21, zaklad: 1, dph: 0 }] });
  odmitni("daň při sazbě 0 % (ztratila by se)", { rozpisDph: [{ sazba: 0, zaklad: 100, dph: 5 }] });
  odmitni("měna malými písmeny", { mena: "eur", kurz: 25 });
  odmitni("EUR bez kurzu", { mena: "EUR", kurz: null });
  odmitni("EUR s nulovým kurzem", { mena: "EUR", kurz: 0 });
  odmitni("kurz s 5 desetinnými místy", { mena: "EUR", kurz: 24.12345 });
  odmitni("kurz jako text", { mena: "EUR", kurz: "24.3" });
  odmitni("neplatné datum (30. února)", { datumVystaveni: "2026-02-30" });
  odmitni("datum v jiném formátu", { datumVystaveni: "1.10.2026" });
  odmitni("chybějící datumVystaveni", { datumVystaveni: null });
  odmitni("IČO dodavatele 9 číslic", { dodavatel: { nazev: "X", ico: "123456789" } });
  odmitni("IČO dodavatele s písmeny", { dodavatel: { nazev: "X", ico: "12AB5678" } });
  odmitni("dodavatel bez názvu", { dodavatel: { nazev: "", ico: "12345678" } });
  odmitni("dodavatel jako pole", { dodavatel: [] });
  odmitni("stát tří písmen", { dodavatel: { nazev: "X", ico: "1", stat: "CZE" } });
  odmitni("název dodavatele nad limit 200", { dodavatel: { nazev: "x".repeat(201), ico: "1" } });
  odmitni("popis nad limit 1000", { popis: "x".repeat(1001) });
  odmitni("id s dvojtečkou", { id: "a:b" });
  odmitni("id delší než 40", { id: "x".repeat(41) });
  odmitni("odběratel bez IČO", { odberatel: { nazev: "X" } });

  it("doklad, který není objekt (null, pole, text, číslo), se odmítne bez výjimky", () => {
    for (const x of [null, undefined, [], "x", 1, true]) assert.equal(parseDoklad(x).ok, false);
  });

  it("zděděné vlastnosti (__proto__, constructor) nejsou vstupem", () => {
    const evil = JSON.parse('{"__proto__": {"typ": "faktura_prijata", "stav": "schvaleno"}}') as unknown;
    assert.equal(parseDoklad(evil).ok, false);
    const proto = Object.create({ typ: "faktura_prijata", stav: "schvaleno" }) as unknown;
    assert.equal(parseDoklad(proto).ok, false);
  });

  it("amountToCents a kurzToString: hraniční hodnoty", () => {
    assert.equal(amountToCents(0.1 + 0.2), null, "0.30000000000000004 není platná částka");
    assert.equal(amountToCents(1234.5), 123450);
    assert.equal(amountToCents(-12.34), -1234);
    assert.equal(amountToCents(99999999.99), 9999999999);
    assert.equal(amountToCents(100000000), null);
    assert.equal(amountToCents(NaN), null);
    assert.equal(amountToCents(Infinity), null);
    assert.equal(amountToCents("1"), null);
    assert.equal(amountToCents(null), null);
    assert.equal(kurzToString(24.315), "24.315");
    assert.equal(kurzToString(9999.9999), "9999.9999");
    assert.equal(kurzToString(10000), null);
    assert.equal(kurzToString(-1), null);
    assert.equal(kurzToString(1e-7), null);
  });
});

describe("načtení souborů – limity a chyby (exit 1)", () => {
  function tmp(): { dir: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taxy-in-"));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it("nevalidní JSON, ne-UTF-8 a chybějící soubor = VstupniChyba", () => {
    const t = tmp();
    try {
      const bad = path.join(t.dir, "bad.json");
      fs.writeFileSync(bad, "{ nejde");
      assert.throws(() => loadKlienti(bad), VstupniChyba);
      assert.throws(() => loadDoklady(bad), VstupniChyba);
      assert.throws(() => loadKlienti(path.join(t.dir, "neni.json")), VstupniChyba);
      assert.throws(() => loadDoklady(t.dir), VstupniChyba, "adresář místo souboru");
      assert.throws(() => parseJsonBuffer(Buffer.from([0x7b, 0xe8, 0x7d]), "x"), VstupniChyba, "Win-1250 bajty");
      assert.deepEqual(parseJsonBuffer(Buffer.from("﻿[1]"), "x"), [1], "BOM se toleruje");
    } finally {
      t.cleanup();
    }
  });

  it("soubory nad limit velikosti se nečtou", () => {
    const t = tmp();
    try {
      const k = path.join(t.dir, "k.json");
      fs.writeFileSync(k, " ".repeat(MAX_KLIENTI_BYTES + 1));
      assert.throws(() => loadKlienti(k), VstupniChyba);
      const d = path.join(t.dir, "d.json");
      fs.writeFileSync(d, " ".repeat(MAX_DOKLADY_BYTES + 1));
      assert.throws(() => loadDoklady(d), VstupniChyba);
    } finally {
      t.cleanup();
    }
  });

  it("struktura: doklady musí být pole, max. 5 000; klienti objekt s neprázdným polem", () => {
    assert.throws(() => parseDokladyFile({}), VstupniChyba);
    assert.throws(() => parseDokladyFile(new Array<unknown>(MAX_DOKLADU + 1).fill(0)), VstupniChyba);
    assert.equal(parseDokladyFile(new Array<unknown>(MAX_DOKLADU).fill(0)).length, MAX_DOKLADU);
    assert.throws(() => parseKlienti([]), VstupniChyba);
    assert.throws(() => parseKlienti({ klienti: [] }), VstupniChyba);
    assert.throws(() => parseKlienti({ klienti: [null] }), VstupniChyba);
    assert.throws(() => parseKlienti({ klienti: [{ klientId: "1", nazev: "A", ico: "1", kaktusFirma: "0001" }] }), VstupniChyba);
    assert.throws(() => parseKlienti({ klienti: [{ klientId: 1, nazev: "A", ico: "123456789", kaktusFirma: "0001" }] }), VstupniChyba);
    const ok = parseKlienti({ klienti: [{ klientId: 1, nazev: "A", ico: "242659", kaktusFirma: "0001" }] });
    assert.equal(ok[0]?.ico, "00242659", "IČO se doplní nulami");
  });
});

describe("authorizeKlient", () => {
  const f1 = fd(firma("0001", "90412761"));
  const f2 = fd(firma("0002", "90581130"));

  it("projde jen při shodě klientId -> firma a IČO odběratele == klienta == FIRMY.ICO", () => {
    const r = authorizeKlient(4172, "90412761", klienti, mapa(f1, f2));
    assert.ok(r.ok);
    assert.equal(r.firma.id, "0001");
  });

  it("odmítne: neznámý klient, cizí odběratel, firma neexistuje / smazaná / bez IČO, IČO firmy jiné než klienta", () => {
    const a = (id: number, ico: string, kl: Klient[], m: Map<string, FirmaData>) => authorizeKlient(id, ico, kl, m);
    assert.equal(a(1, "90412761", klienti, mapa(f1, f2)).ok, false);
    assert.equal(a(4172, "90581130", klienti, mapa(f1, f2)).ok, false, "IČO druhé firmy");
    assert.equal(a(4180, "90412761", klienti, mapa(f1, f2)).ok, false);
    assert.equal(a(4172, "90412761", klienti, mapa(f2)).ok, false, "firma nenačtena = neexistuje");
    assert.equal(a(4172, "90412761", klienti, mapa(fd(firma("0001", "90412761", true)))).ok, false, "smazaná firma");
    assert.equal(a(4172, "90412761", klienti, mapa(fd(firma("0001", null)))).ok, false, "firma bez IČO");
    assert.equal(a(4172, "90412761", klienti, mapa(fd(firma("0001", "90000000")))).ok, false, "FIRMY.ICO jiné než klienta");
    const dup: Klient[] = [...klienti, { klientId: 4172, nazev: "dup", ico: "90412761", kaktusFirma: "0002" }];
    assert.equal(a(4172, "90412761", dup, mapa(f1, f2)).ok, false, "klientId dvakrát");
    const evil: Klient[] = [{ klientId: 4172, nazev: "x", ico: "90412761", kaktusFirma: "../0002" }];
    assert.equal(a(4172, "90412761", evil, mapa(f2)).ok, false);
    const mismatch = new Map([["0001", fd(firma("0002", "90412761"))]]);
    assert.equal(a(4172, "90412761", klienti, mismatch).ok, false, "ID firmy v datech jiné než klíč");
  });
});

describe("planWrite", () => {
  const f1 = (faktury: FakturaPrijata[] = [], dodavatele: Dodavatel[] = []) => fd(firma("0001", "90412761"), dodavatele, faktury);
  const f2 = () => fd(firma("0002", "90581130"));

  it("pořadí kontrol: autorizace dřív než validace (doklad cizího klienta se ani nevaliduje)", () => {
    const p = planWrite(klienti, [mkDoklad("p1", { klientId: 999, cisloDokladu: null })], mapa(f1(), f2()));
    assert.equal(p.vysledky[0]?.stav, "odmitnuto");
    assert.match(p.vysledky[0]?.duvod ?? "", /999/);
    assert.equal(p.vysledky[0]?.firma, null);
  });

  it("doklad s id a klientem, ale bez odběratele, se odmítne (nehádá se firma)", () => {
    const d = mkDoklad("p2");
    delete d.odberatel;
    const p = planWrite(klienti, [d], mapa(f1(), f2()));
    assert.equal(p.vysledky[0]?.stav, "odmitnuto");
    assert.equal(p.perFirma.size, 0);
  });

  it("firma z dokladu (firma/kaktusFirma/slozka) se ignoruje", () => {
    const p = planWrite(klienti, [mkDoklad("p3", { firma: "0002", kaktusFirma: "0002" })], mapa(f1(), f2()));
    assert.equal(p.vysledky[0]?.firma, "0001");
    assert.deepEqual([...p.perFirma.keys()], ["0001"]);
  });

  it("výsledky jsou v pořadí vstupu, nevalidní prvky (null, pole) nerozbijí zbytek", () => {
    const p = planWrite(klienti, [null, [], mkDoklad("p4"), "x"], mapa(f1(), f2()));
    assert.deepEqual(p.vysledky.map((v) => v.stav), ["odmitnuto", "odmitnuto", "k_zapisu", "odmitnuto"]);
    assert.deepEqual(p.vysledky.map((v) => v.index), [0, 1, 2, 3]);
  });

  it("jiz_zapsano podle značky TAXY:<id>, i když je jiné číslo dokladu", () => {
    const data = f1([fak(1, 1, "JINE", "TAXY:p5")], [dod(1, "90999001", "X")]);
    const p = planWrite(klienti, [mkDoklad("p5")], mapa(data, f2()));
    assert.equal(p.vysledky[0]?.stav, "jiz_zapsano");
    assert.equal(p.vysledky[0]?.kaktusDoklad, "FP260001");
  });

  it("TAXY:doc_1 není shoda pro doc_12 (celé ID, ne předpona)", () => {
    const data = f1([fak(1, null, "N", "TAXY:doc_12")]);
    const p = planWrite(klienti, [mkDoklad("doc_1"), mkDoklad("doc_12")], mapa(data, f2()));
    assert.equal(p.vysledky[0]?.stav, "k_zapisu");
    assert.equal(p.vysledky[1]?.stav, "jiz_zapsano");
  });

  it("smazaný záznam s naší značkou = odmitnuto (smazáno v Kaktusu); smazaný ruční záznam bez značky = k_zapisu s varováním", () => {
    const data = f1(
      [fak(1, 1, "T-p6", "TAXY:p6", true), fak(2, 1, "T-p7", "", true)],
      [dod(1, "90999001", "Testovací dodavatel p6"), dod(2, "90999001", "Testovací dodavatel p7")],
    );
    const p = planWrite(klienti, [mkDoklad("p6"), mkDoklad("p7")], mapa(data, f2()));
    assert.deepEqual(p.vysledky.map((v) => v.stav), ["odmitnuto", "k_zapisu"]);
    assert.match(p.vysledky[0]?.duvod ?? "", /smazán/);
    assert.equal(p.vysledky[0]?.odlozitNa, undefined);
    assert.ok(p.vysledky[1]?.varovani.some((v) => /smazaný doklad/.test(v)));
  });

  it("záložní shoda jde přes VŠECHNY partnery se stejným IČO (Pila Ořech ID 7 a 19)", () => {
    const partneri = [dod(7, "90100077", "Pila Ořech s.r.o."), dod(19, "90100077", "PILA OŘECH SRO")];
    // ruční doklad je navázán na druhého (duplicitního) partnera
    const data = f1([fak(5, 19, "2026-0288")], partneri);
    const d = mkDoklad("p8", { cisloDokladu: "2026-0288" });
    (d.dodavatel as Record<string, unknown>).ico = "90100077";
    (d.dodavatel as Record<string, unknown>).nazev = "Pila Ořech s.r.o.";
    const p = planWrite(klienti, [d], mapa(data, f2()));
    assert.equal(p.vysledky[0]?.stav, "jiz_zapsano");
    assert.equal(p.vysledky[0]?.kaktusDoklad, "FP260005");
  });

  it("záložní shoda bez IČO jde přes přesný název (ořezaný na 40)", () => {
    const nazev = "N".repeat(40);
    const data = f1([fak(5, 3, "X1")], [dod(3, null, nazev)]);
    const d = mkDoklad("p9", { cisloDokladu: "X1" });
    d.dodavatel = { nazev: "N".repeat(60), ico: null, dic: null, ulice: null, mesto: null, psc: null, stat: null };
    assert.equal(planWrite(klienti, [d], mapa(data, f2())).vysledky[0]?.stav, "jiz_zapsano");
    d.dodavatel = { nazev: "M".repeat(60), ico: null, dic: null, ulice: null, mesto: null, psc: null, stat: null };
    assert.equal(planWrite(klienti, [d], mapa(data, f2())).vysledky[0]?.stav, "k_zapisu");
  });

  it("IČO s úvodními nulami se porovnává normalizovaně (242659 == 00242659)", () => {
    const data = f1([fak(5, 3, "NAJ")], [dod(3, "00242659", "Obec Háje")]);
    const d = mkDoklad("p10", { cisloDokladu: "NAJ" });
    (d.dodavatel as Record<string, unknown>).ico = "242659";
    assert.equal(planWrite(klienti, [d], mapa(data, f2())).vysledky[0]?.stav, "jiz_zapsano");
  });

  it("dedup je po firmách: stejný doklad v jiné firmě nevadí", () => {
    const druha = fd(firma("0002", "90581130"), [dod(1, "90999001", "X")], [fak(1, 1, "T-p11")]);
    const p = planWrite(klienti, [mkDoklad("p11")], mapa(f1(), druha));
    assert.equal(p.vysledky[0]?.stav, "k_zapisu");
  });

  it("duplicita ve vstupu: druhý výskyt odmitnuto, i když se liší jen mezerami / ořezem na 20 znaků", () => {
    const a = mkDoklad("q1", { cisloDokladu: "ABCDEFGHIJ0123456789-X" });
    const b = mkDoklad("q2", { cisloDokladu: "ABCDEFGHIJ0123456789-Y" });
    const c = mkDoklad("q3", { cisloDokladu: " ABCDEFGHIJ0123456789 " });
    const p = planWrite(klienti, [a, b, c], mapa(f1(), f2()));
    assert.deepEqual(p.vysledky.map((v) => v.stav), ["k_zapisu", "odmitnuto", "odmitnuto"]);
  });

  it("druhý doklad se stejným číslem po již zapsaném prvním zůstane odmitnuto (stabilní výsledek při opakování)", () => {
    const data = f1([fak(1, 1, "C", "TAXY:r1")], [dod(1, "90999001", "Testovací dodavatel r1")]);
    const a = mkDoklad("r1", { cisloDokladu: "C" });
    const b = mkDoklad("r2", { cisloDokladu: "C" });
    (b.dodavatel as Record<string, unknown>).nazev = "Testovací dodavatel r1";
    const p = planWrite(klienti, [a, b], mapa(data, f2()));
    assert.equal(p.vysledky[0]?.stav, "jiz_zapsano");
    assert.equal(p.vysledky[1]?.stav, "odmitnuto", "pořadí kontrol: značka, duplicita ve vstupu, záložní shoda");
    assert.match(p.vysledky[1]?.duvod ?? "", /Duplicita ve vstupu/);
  });
});

describe("dedup: extractTaxyIds, dokladKey, index", () => {
  it("extractTaxyIds: celé ID, více značek, nesouvisející text", () => {
    assert.deepEqual(extractTaxyIds("TAXY:doc_1"), ["doc_1"]);
    assert.deepEqual(extractTaxyIds("ručně; TAXY:a-1 TAXY:b_2"), ["a-1", "b_2"]);
    assert.deepEqual(extractTaxyIds("XTAXY:doc_1"), [], "před značkou musí být hranice");
    assert.deepEqual(extractTaxyIds("taxy:doc_1"), []);
    assert.deepEqual(extractTaxyIds(""), []);
    assert.deepEqual(extractTaxyIds("TAXY:"), []);
  });

  it("dokladKey: s IČO podle IČO (nuly, mezery), bez IČO podle názvu", () => {
    assert.equal(dokladKey("242659", "A", " X "), dokladKey("00242659", "B", "X"));
    assert.notEqual(dokladKey("242659", "A", "X"), dokladKey("242658", "A", "X"));
    assert.notEqual(dokladKey(null, "A", "X"), dokladKey(null, "B", "X"));
    assert.notEqual(dokladKey(null, "A", "X"), dokladKey("1", "A", "X"));
  });

  it("buildDedupIndex: živé a smazané se oddělí, smazaný partner se pro nesmazaný doklad použije", () => {
    const idx = buildDedupIndex({
      dodavatele: [dod(1, "00000001", "P", true)],
      faktury: [fak(1, 1, "A"), fak(2, 1, "A", "", true), fak(3, null, "B"), fak(4, 99, "C")],
    });
    const h = lookupNumber(idx, dokladKey("1", "P", "A"));
    assert.deepEqual(h.zive.map((f) => f.id), [1]);
    assert.deepEqual(h.smazane.map((f) => f.id), [2]);
    assert.equal(lookupNumber(idx, dokladKey(null, "P", "B")).zive.length, 0, "doklad bez partnera nelze přiřadit");
    assert.equal(lookupMarker(idx, "nic").zive.length, 0);
  });
});
