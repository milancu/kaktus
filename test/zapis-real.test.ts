// Scénáře 2 a 4 (+ části 7, 8, 11): zápis reálných dat TAXY do kopie Kaktusu a ověření skutečného
// stavu DBF (přes read.ts), ne jen reportu. Druhý běh nad stejnou kopií = důkaz idempotence.
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { zapis } from "../src/write";
import type { ZapisReport } from "../src/write";
import { readAll } from "../src/kaktus/read";
import type { FirmaData } from "../src/kaktus/read";
import {
  makeSandbox, hashTree, ORIG_KAKTUS, realKlienti, realDoklady, realDoklad, data, byMarker, radek,
  adresarBytes, fakpriBytes, listDir,
} from "./helpers";
import type { Sandbox } from "./helpers";

const NAZEV_63 = "Výroba a montáž dřevěných konstrukcí Hořovice, výrobní družstvo";

describe("Zápis reálných dat TAXY do kopie Kaktusu", () => {
  let sb: Sandbox;
  let origBefore: string;
  let pred1: FirmaData;
  let pred2: FirmaData;
  let po1: FirmaData;
  let po2: FirmaData;
  let report: ZapisReport;

  before(async () => {
    origBefore = hashTree(ORIG_KAKTUS);
    sb = makeSandbox();
    pred1 = data(sb, "0001");
    pred2 = data(sb, "0002");
    report = await zapis({ kaktusDir: sb.kaktusDir, klienti: realKlienti(), doklady: realDoklady(), tmpRoot: sb.tmpRoot });
    po1 = data(sb, "0001");
    po2 = data(sb, "0002");
  });
  after(() => {
    sb.cleanup();
    assert.equal(hashTree(ORIG_KAKTUS), origBefore, "originální složka kaktus/ se nesmí změnit");
  });

  it("report: 37 dokladů, souhrn podle stavů a v pořadí vstupu", () => {
    assert.equal(report.format, 1);
    assert.equal(report.rezim, "zapis");
    assert.equal(report.doklady.length, 37);
    assert.deepEqual(report.doklady.map((d) => d.id), (realDoklady() as { id: string }[]).map((d) => d.id));
    assert.deepEqual(report.souhrn.pocty, {
      zapsano: 29, jiz_zapsano: 3, odmitnuto: 4, chyba_kaktusu: 1, neprovedeno: 0, k_zapisu: 0,
    });
    assert.equal(report.souhrn.firmy["0001"]?.pocty.zapsano, 24);
    assert.equal(report.souhrn.firmy["0002"]?.pocty.zapsano, 5);
    assert.equal(report.souhrn.firmy["0001"]?.preruseno, undefined);
    assert.ok(!JSON.stringify(report).includes('"rozpisDph"'), "report nesmí obsahovat celé doklady");
  });

  it("počet nových řádků FAKPRI = počet zapsano (po firmách) a nic se nemazalo", () => {
    assert.equal(po1.faktury.length - pred1.faktury.length, 24);
    assert.equal(po2.faktury.length - pred2.faktury.length, 5);
    // původní záznamy zůstaly beze změny
    assert.deepEqual(po1.faktury.slice(0, pred1.faktury.length), pred1.faktury);
    assert.deepEqual(po2.faktury.slice(0, pred2.faktury.length), pred2.faktury);
    assert.deepEqual(po1.dodavatele.slice(0, pred1.dodavatele.length), pred1.dodavatele);
  });

  it("každý zapsaný doklad je v DBF právě jednou, POZN = TAXY:<id>, číslo dokladu sedí s reportem", () => {
    const zapsane = report.doklady.filter((d) => d.stav === "zapsano");
    assert.equal(zapsane.length, 29);
    const cisla = new Set<string>();
    for (const d of zapsane) {
      const f = d.firma === "0001" ? po1 : po2;
      const hits = byMarker(f, d.id as string);
      assert.equal(hits.length, 1, `${d.id}: očekáván právě jeden záznam`);
      assert.equal(hits[0]?.poznamka, `TAXY:${d.id}`);
      assert.equal(hits[0]?.doklad, d.kaktusDoklad);
      assert.match(hits[0]?.doklad ?? "", /^FP26\d{4}$/);
      assert.ok(!cisla.has(`${d.firma}/${d.kaktusDoklad}`), "číslo dokladu se opakuje");
      cisla.add(`${d.firma}/${d.kaktusDoklad}`);
    }
    // nikdo jiný (staré záznamy, zamítnuté, jiz_zapsano) značku nemá
    const sMarkerem = [...po1.faktury, ...po2.faktury].filter((x) => x.poznamka.startsWith("TAXY:"));
    assert.equal(sMarkerem.length, 29);
  });

  it("odmitnuto: neznámý klient 5033, nesoulad odběratele (doc_00d80d05f4), cisloDokladu null – nikam nezapsáno", () => {
    for (const id of ["doc_d38c9d950c", "doc_00d80d05f4", "doc_340661d8d9"]) {
      const r = radek(report, id);
      assert.equal(r.stav, "odmitnuto", id);
      assert.ok((r.duvod ?? "").length > 0);
      assert.equal(byMarker(po1, id).length + byMarker(po2, id).length, 0);
    }
    assert.match(radek(report, "doc_d38c9d950c").duvod ?? "", /5033/);
    assert.equal(radek(report, "doc_d38c9d950c").firma, null);
    assert.equal(radek(report, "doc_00d80d05f4").firma, null, "odmítnuto před určením firmy");
    // nic z odmítnutých nesmí být v Kaktusu: ani doklad, ani partner
    for (const f of [po1, po2]) {
      assert.ok(!f.faktury.some((x) => x.cisloDodavatele === "MO-26-07731"));
      assert.ok(!f.faktury.some((x) => x.cisloDodavatele === "2026/778"));
    }
    // žádný nový partner kvůli odmítnutým dokladům (Mlékárna Olešná, Papírnictví Sova)
    const pocet = (f: FirmaData, ico: string) => f.dodavatele.filter((x) => x.ico === ico).length;
    for (const ico of ["90200039", "90300033"]) {
      assert.equal(pocet(po1, ico), pocet(pred1, ico), ico);
      assert.equal(pocet(po2, ico), pocet(pred2, ico), ico);
    }
    assert.ok(!po1.faktury.some((x) => x.variabilniSymbol === "2600412"));
  });

  it("doc_846133b7f9 (DUZP 2025): chyba_kaktusu s kódem E220, v DBF není", () => {
    const r = radek(report, "doc_846133b7f9");
    assert.equal(r.stav, "chyba_kaktusu");
    assert.equal(r.kod, "E220");
    assert.equal(byMarker(po1, "doc_846133b7f9").length, 0);
    assert.ok(!po1.faktury.some((x) => x.cisloDodavatele === "2025-3391"));
  });

  it("jiz_zapsano: doc_c36efaf63f (Čáp), doc_00a5091cef (Háje, jiný VS), doc_fd03b52d28 (Perner, firma 0002)", () => {
    const ocekavane: [string, string][] = [
      ["doc_c36efaf63f", "FP260045"], ["doc_00a5091cef", "FP260042"], ["doc_fd03b52d28", "FP260012"],
    ];
    for (const [id, doklad] of ocekavane) {
      const r = radek(report, id);
      assert.equal(r.stav, "jiz_zapsano", id);
      assert.equal(r.kaktusDoklad, doklad);
      assert.equal(byMarker(po1, id).length + byMarker(po2, id).length, 0, "nic nového se nezapisuje");
    }
    // žádný nový záznam se stejným číslem dodavatele
    const count = (f: FirmaData, c: string) => f.faktury.filter((x) => !x.smazano && x.cisloDodavatele === c).length;
    assert.equal(count(po1, "2026-0931"), 1);
    assert.equal(count(po1, "NAJ-2026-09"), 1);
    assert.equal(count(po2, "FV-2609-0188"), 1);
  });

  it("duplicita ve vstupu 260914 (Kování Říha 2x): zapsán přesně jeden, druhý odmítnut", () => {
    assert.equal(radek(report, "doc_3c0d1615f6").stav, "zapsano");
    const druhy = radek(report, "doc_a88ae33500");
    assert.equal(druhy.stav, "odmitnuto");
    assert.match(druhy.duvod ?? "", /Duplicita ve vstupu/);
    const nove = po1.faktury.filter((x) => !x.smazano && x.cisloDodavatele === "260914");
    assert.equal(nove.length, 1);
    assert.equal(nove[0]?.poznamka, "TAXY:doc_3c0d1615f6");
    assert.equal(byMarker(po1, "doc_a88ae33500").length, 0);
  });

  it("smazaný FV26001877 Kuběna: nová faktura zapsána s varováním, smazaná zůstala smazaná", () => {
    const r = radek(report, "doc_61ed535421");
    assert.equal(r.stav, "zapsano");
    assert.ok(r.varovani.some((v) => /smazaný doklad/.test(v) && v.includes("FP260039")), r.varovani.join("|"));
    const nova = byMarker(po1, "doc_61ed535421");
    assert.equal(nova.length, 1);
    assert.equal(nova[0]?.cisloDodavatele, "FV26001877");
    assert.equal(nova[0]?.partnerId, 8, "existující partner Kuběna");
    const stara = po1.faktury.find((x) => x.doklad === "FP260039");
    assert.equal(stara?.smazano, true);
    assert.equal(stara?.poznamka, pred1.faktury.find((x) => x.doklad === "FP260039")?.poznamka);
  });

  it("Brusivo: součet 2440,57 vs. 2441 projde (tolerance), částky v haléřích přesně", () => {
    assert.equal(radek(report, "doc_dc39d3bb48").stav, "zapsano");
    const f = byMarker(po1, "doc_dc39d3bb48")[0];
    assert.equal(f?.zaklad21, 201700);
    assert.equal(f?.dph21, 42357);
    assert.equal(f?.celkem, 244100);
    assert.equal(f?.cisloDodavatele, "26100031");
  });

  it("název dodavatele 63 znaků: ořez na 40 + varování, partner v ADRESAR s ořezaným názvem", () => {
    const r = radek(report, "doc_fd3f74cd5a");
    assert.equal(r.stav, "zapsano");
    assert.ok(r.varovani.some((v) => /Název dodavatele: ořezáno z 63 na 40/.test(v)), r.varovani.join("|"));
    const ocekavany = NAZEV_63.slice(0, 40).trimEnd();
    const partneri = po1.dodavatele.filter((x) => x.ico === "90300025");
    assert.equal(partneri.length, 1);
    assert.equal(partneri[0]?.nazev, ocekavany);
    assert.ok(partneri[0] && partneri[0].id > Math.max(...pred1.dodavatele.map((x) => x.id)), "nový partner");
    assert.equal(byMarker(po1, "doc_fd3f74cd5a")[0]?.partnerId, partneri[0]?.id);
  });

  it("→ v textu je transliterováno na ->, v DBF žádné ?, plus varování", () => {
    const r = radek(report, "doc_fd3f74cd5a");
    assert.ok(r.varovani.some((v) => v.includes("→") && v.includes("->")), r.varovani.join("|"));
    const f = byMarker(po1, "doc_fd3f74cd5a")[0];
    assert.equal(f?.text, "Krov - díl A -> montáž 10/2026");
    assert.ok(!f?.text.includes("?"));
  });

  it("EUR s kurzem: měna, kurz a částky v DBF; dodavatel bez IČO", () => {
    const r = radek(report, "doc_39ad40f7b2");
    assert.equal(r.stav, "zapsano");
    const f = byMarker(po1, "doc_39ad40f7b2")[0];
    assert.equal(f?.mena, "EUR");
    assert.equal(f?.kurz, 24.315);
    assert.equal(f?.zaklad0, 236000);
    assert.equal(f?.celkem, 236000);
    const p = po1.dodavatele.find((x) => x.id === f?.partnerId);
    assert.equal(p?.nazev, "Holz Bauer GmbH");
    assert.equal(p?.ico, null);
    assert.equal(p?.stat, "DE");
  });

  it("3 sazby v jednom dokladu: všechny základy a daně v DBF", () => {
    assert.equal(radek(report, "doc_86bc621124").stav, "zapsano");
    const f = byMarker(po1, "doc_86bc621124")[0];
    assert.equal(f?.zaklad21, 101990);
    assert.equal(f?.dph21, 21418);
    assert.equal(f?.zaklad12, 31030);
    assert.equal(f?.dph12, 3724);
    assert.equal(f?.zaklad0, 4570);
    assert.equal(f?.celkem, 162732);
  });

  it("IČO 00242659: nový doklad Háje (NAJ-2026-10) jde na existujícího partnera 15, nevznikne duplicitní partner", () => {
    assert.equal(radek(report, "doc_5b2db4a6e2").stav, "zapsano");
    assert.equal(byMarker(po1, "doc_5b2db4a6e2")[0]?.partnerId, 15);
    assert.equal(po1.dodavatele.filter((x) => x.ico === "00242659").length, 1);
  });

  it("duplicitní partner Pila Ořech (7 a 19): doklad jde na první nesmazaný (7), žádný třetí partner", () => {
    assert.equal(radek(report, "doc_c34d189eac").stav, "zapsano");
    assert.equal(byMarker(po1, "doc_c34d189eac")[0]?.partnerId, 7);
    assert.deepEqual(po1.dodavatele.filter((x) => x.ico === "90100077").map((x) => x.id), [7, 19]);
  });

  it("Novák & syn: název v ADRESAR doslovně s &, ne &amp;", () => {
    assert.equal(radek(report, "doc_49aa18c650").stav, "zapsano");
    const f = byMarker(po1, "doc_49aa18c650")[0];
    assert.equal(po1.dodavatele.find((x) => x.id === f?.partnerId)?.nazev, "Novák & syn, s.r.o.");
  });

  it("dodavatel bez DIČ účtující DPH: zapsáno s varováním", () => {
    const r = radek(report, "doc_8c8a7f4e87");
    assert.equal(r.stav, "zapsano");
    assert.ok(r.varovani.some((v) => /nemá DIČ/.test(v)));
  });

  it("diakritika zapsaná do DBF se čte zpět beze ztráty (CP852 round-trip)", () => {
    const f = byMarker(po1, "doc_fb9210fb46")[0];
    const p = po1.dodavatele.find((x) => x.id === f?.partnerId);
    assert.equal(p?.nazev, "Lakovna Žďár s.r.o.");
    assert.equal(p?.mesto, "Žďár nad Sázavou");
    assert.equal(p?.ulice, "Jihlavská 1140");
    for (const x of [...po1.dodavatele, ...po2.dodavatele]) assert.ok(!x.nazev.includes("?"), x.nazev);
  });

  it("dávky > 20: firma 0001 měla 24 zapsaných dokladů (dvě dávky), všechny v DBF", () => {
    const ids = report.doklady.filter((d) => d.firma === "0001" && d.stav === "zapsano").map((d) => d.id as string);
    assert.equal(ids.length, 24);
    for (const id of ids) assert.equal(byMarker(po1, id).length, 1, id);
  });

  it("po běhu nezůstaly dočasné adresáře", () => {
    assert.deepEqual(listDir(sb.tmpRoot), []);
  });

  describe("druhý běh (idempotence)", () => {
    let report2: ZapisReport;
    let fakBefore1: Buffer;
    let fakBefore2: Buffer;
    let adrBefore1: Buffer;
    let adrBefore2: Buffer;

    before(async () => {
      fakBefore1 = fakpriBytes(sb, "0001");
      fakBefore2 = fakpriBytes(sb, "0002");
      adrBefore1 = adresarBytes(sb, "0001");
      adrBefore2 = adresarBytes(sb, "0002");
      report2 = await zapis({ kaktusDir: sb.kaktusDir, klienti: realKlienti(), doklady: realDoklady(), tmpRoot: sb.tmpRoot });
      po2 = data(sb, "0002");
    });

    it("nic nezapíše: FAKPRI i ADRESAR obou firem jsou bajtově shodné", () => {
      assert.ok(fakpriBytes(sb, "0001").equals(fakBefore1));
      assert.ok(fakpriBytes(sb, "0002").equals(fakBefore2));
      assert.ok(adresarBytes(sb, "0001").equals(adrBefore1));
      assert.ok(adresarBytes(sb, "0002").equals(adrBefore2));
    });

    it("žádné zapsano; dřívější zapsano jsou nyní jiz_zapsano se stejným číslem dokladu", () => {
      assert.equal(report2.souhrn.pocty.zapsano, 0);
      assert.equal(report2.souhrn.pocty.neprovedeno, 0);
      assert.equal(report2.souhrn.pocty.jiz_zapsano, 32);
      assert.equal(report2.souhrn.pocty.odmitnuto, 4);
      assert.equal(report2.souhrn.pocty.chyba_kaktusu, 1, "E220 se zkouší znovu, v DBF po něm nic nezůstane");
      for (const d of report.doklady.filter((x) => x.stav === "zapsano")) {
        const r2 = radek(report2, d.id as string);
        assert.equal(r2.stav, "jiz_zapsano", d.id as string);
        assert.equal(r2.kaktusDoklad, d.kaktusDoklad);
      }
    });

    it("report je deterministický (bez časového razítka) a druhý běh nenechal tmp", () => {
      const jedna = JSON.stringify(report2);
      assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(jedna), "report nesmí obsahovat časové razítko");
      assert.deepEqual(listDir(sb.tmpRoot), []);
      assert.equal(readAll(sb.kaktusDir).firmy[0]?.faktury?.length, 70);
    });
  });
});
