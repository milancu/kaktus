// Scénář 9 a 10 (jednotkově): parser odpovědi Kaktusu, spouštěč importu (execFile bez shellu,
// timeout), mapování exit kódů a ověření dávky podle DBF (reconcileDavka).
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decodeEntities, defaultRunner, importDavka, mapExitCode, MAX_ODPOVED_BYTES, OdpovedChyba, parseOdpoved, resolveKaktusScript,
  runImport,
} from "../src/kaktus/import";
import type { ImportVysledek, OdpovedDoklad, OdpovedKaktusu } from "../src/kaktus/import";
import { encodeWin1250 } from "../src/codec";
import { reconcileDavka } from "../src/write";
import { VstupniChyba } from "../src/errors";
import type { Dodavatel, FakturaPrijata } from "../src/kaktus/read";

const enc = (s: string): Buffer => encodeWin1250(s);
const odp = (body: string, firma = "0001", extra = ""): Buffer =>
  enc(`<?xml version="1.0" encoding="windows-1250"?>\r\n<KaktusOdpoved firma="${firma}"${extra}>\r\n${body}</KaktusOdpoved>\r\n`);
const OK = (n: number, d = "FP260100"): string => `  <Doklad poradi="${n}" stav="OK" doklad="${d}"/>\r\n`;
const ERR = (n: number, k = "E220", z = "Chyba"): string => `  <Doklad poradi="${n}" stav="CHYBA" kod="${k}" zprava="${z}"/>\r\n`;

describe("parseOdpoved", () => {
  it("platná odpověď: OK i CHYBA, český text ve Win-1250, neznámé atributy se ignorují", () => {
    const r = parseOdpoved(odp(`${OK(1)}${ERR(2, "E210", "Částka neodpovídá &amp; součtu")}`, "0001", ' zapsano="1" odmitnuto="1" foo="bar"'), { firma: "0001", pocet: 2 });
    assert.equal(r.firma, "0001");
    assert.equal(r.doklady.size, 2);
    assert.deepEqual(r.doklady.get(1), { poradi: 1, stav: "OK", doklad: "FP260100" });
    assert.equal(r.doklady.get(2)?.kod, "E210");
    assert.equal(r.doklady.get(2)?.zprava, "Částka neodpovídá & součtu");
  });

  it("neznámý atribut u Doklad se ignoruje", () => {
    const r = parseOdpoved(odp('  <Doklad poradi="1" stav="OK" doklad="FP260001" nic="x"/>\r\n'), { firma: "0001", pocet: 1 });
    assert.equal(r.doklady.get(1)?.doklad, "FP260001");
  });

  it("chybějící Doklad není chyba parseru (položka zůstane bez výsledku)", () => {
    const r = parseOdpoved(odp(OK(1)), { firma: "0001", pocet: 3 });
    assert.equal(r.doklady.size, 1);
    assert.equal(r.doklady.has(2), false);
    assert.equal(parseOdpoved(odp(""), { firma: "0001", pocet: 3 }).doklady.size, 0);
    assert.equal(parseOdpoved(enc('<KaktusOdpoved firma="0001"/>'), { firma: "0001", pocet: 3 }).doklady.size, 0);
  });

  it("DOCTYPE a ENTITY (XXE, billion laughs) se odmítnou", () => {
    const lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]><KaktusOdpoved firma="0001"><Doklad poradi="1" stav="CHYBA" kod="E100" zprava="&lol2;"/></KaktusOdpoved>';
    const xxe = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><KaktusOdpoved firma="0001"/>';
    const lower = '<!doctype x><KaktusOdpoved firma="0001"/>';
    const entityOnly = '<KaktusOdpoved firma="0001"><!ENTITY a "b"></KaktusOdpoved>';
    for (const x of [lol, xxe, lower, entityOnly, '<!DOCTYPE KaktusOdpoved SYSTEM "http://evil/x.dtd"><KaktusOdpoved firma="0001"/>']) {
      assert.throws(() => parseOdpoved(Buffer.from(x), { firma: "0001", pocet: 1 }), OdpovedChyba, x.slice(0, 40));
    }
  });

  it("komentáře, CDATA, processing instructions a cizí elementy se odmítnou", () => {
    const o = { firma: "0001", pocet: 1 };
    for (const body of [
      "<!-- x -->", "<![CDATA[x]]>", "<?php x ?>", "<Jiny/>", "<Doklad poradi=\"1\" stav=\"OK\" doklad=\"FP260001\"><Vnitrek/></Doklad>",
      "text mimo element", "<Doklad poradi=\"1\" stav=\"OK\" doklad=\"FP260001\"/>\r\n<Doklad poradi=\"1\" stav=\"OK\" doklad=\"FP260002\"/>",
    ]) {
      assert.throws(() => parseOdpoved(enc(`<KaktusOdpoved firma="0001">${body}</KaktusOdpoved>`), o), OdpovedChyba, body);
    }
    assert.throws(() => parseOdpoved(enc('<?xml version="1.0"?><!-- c --><KaktusOdpoved firma="0001"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(enc('<KaktusOdpoved firma="0001"/><X/>'), o), OdpovedChyba, "obsah za kořenem");
    assert.throws(() => parseOdpoved(enc('<Jiny firma="0001"/>'), o), OdpovedChyba, "kořen");
  });

  it("poradi: duplicitní, nula, mimo rozsah, chybějící, nečíselné = chyba", () => {
    const o = { firma: "0001", pocet: 2 };
    assert.throws(() => parseOdpoved(odp(OK(1) + OK(1)), o), /dvakrát/);
    assert.throws(() => parseOdpoved(odp(OK(0)), o), /mimo rozsah/);
    assert.throws(() => parseOdpoved(odp(OK(3)), o), /mimo rozsah/);
    assert.throws(() => parseOdpoved(odp(OK(21)), { firma: "0001", pocet: 20 }), /mimo rozsah/);
    assert.throws(() => parseOdpoved(odp('  <Doklad stav="OK" doklad="FP260001"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp('  <Doklad poradi="a" stav="OK" doklad="FP260001"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp('  <Doklad poradi="1.5" stav="OK" doklad="FP260001"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp('  <Doklad poradi="-1" stav="OK" doklad="FP260001"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp('  <Doklad poradi="1" poradi="2" stav="OK" doklad="FP260001"/>'), o), /dvakrát/);
  });

  it("neplatný stav, kód chyby, číslo dokladu a jiná firma = chyba", () => {
    const o = { firma: "0001", pocet: 2 };
    assert.throws(() => parseOdpoved(odp('  <Doklad poradi="1" stav="MOZNA"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(ERR(1, "X1")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(ERR(1, "E22")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp('  <Doklad poradi="1" stav="OK"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(OK(1, "../x")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(OK(1, "FP26000000001")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(OK(1), "0002"), o), /jiné firmy/);
    assert.throws(() => parseOdpoved(odp(OK(1), "../x"), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(enc("<KaktusOdpoved>"), o), OdpovedChyba);
  });

  it("holé & a neznámá entita, nekorektní entity, useknutá odpověď, prázdný vstup = chyba", () => {
    const o = { firma: "0001", pocet: 1 };
    assert.throws(() => parseOdpoved(odp(ERR(1, "E100", "A & B")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(ERR(1, "E100", "&neznama;")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(ERR(1, "E100", "&#0;")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(ERR(1, "E100", "&#x110000;")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(odp(ERR(1, "E100", "&amp")), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(enc('<KaktusOdpoved firma="0001"><Doklad poradi="1" stav="OK" doklad="FP260001"/>'), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(Buffer.alloc(0), o), OdpovedChyba);
    assert.throws(() => parseOdpoved(enc("<KaktusOdpoved firma=0001/>"), o), OdpovedChyba);
    assert.equal(decodeEntities("a&lt;b&#65;&#x42;"), "a<bAB");
  });

  it("příliš velká odpověď a nepodporované kódování se odmítnou", () => {
    const o = { firma: "0001", pocet: 1 };
    assert.throws(() => parseOdpoved(Buffer.alloc(MAX_ODPOVED_BYTES + 1, 0x20), o), /příliš velká/);
    assert.throws(() => parseOdpoved(Buffer.from('<?xml version="1.0" encoding="UTF-16"?><KaktusOdpoved firma="0001"/>'), o), OdpovedChyba);
  });

  it("zpráva s řídicími znaky se vyčistí a ořízne (do reportu nepustíme libovolný obsah)", () => {
    const dlouha = "x".repeat(1000);
    const r = parseOdpoved(odp(ERR(1, "E100", `a&#9;b&#10;c ${dlouha}`)), { firma: "0001", pocet: 1 });
    const z = r.doklady.get(1)?.zprava ?? "";
    assert.ok(z.startsWith("a b c xxx"));
    assert.ok(z.length <= 301);
  });
});

describe("mapExitCode a defaultRunner", () => {
  it("exit kódy simulátoru 0/2/3/4, ostatní a timeout = pád", () => {
    assert.equal(mapExitCode(0, false).stav, "zpracovano");
    assert.equal(mapExitCode(2, false).stav, "davka_necitelna");
    assert.equal(mapExitCode(3, false).stav, "firma_zamcena");
    assert.equal(mapExitCode(4, false).stav, "firma_neexistuje");
    assert.equal(mapExitCode(1, false).stav, "pad");
    assert.equal(mapExitCode(137, false).stav, "pad");
    assert.equal(mapExitCode(null, false).stav, "pad");
    assert.equal(mapExitCode(0, true).stav, "pad", "timeout přebíjí exit 0");
  });

  function fakeKaktus(script: string): { dir: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taxy-fake-"));
    fs.writeFileSync(path.join(dir, "kaktus.cjs"), script);
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it("resolveKaktusScript: chybějící kaktus.cjs = VstupniChyba", () => {
    const f = fakeKaktus("");
    try {
      assert.equal(resolveKaktusScript(f.dir), path.resolve(f.dir, "kaktus.cjs"));
      fs.rmSync(path.join(f.dir, "kaktus.cjs"));
      assert.throws(() => resolveKaktusScript(f.dir), VstupniChyba);
    } finally {
      f.cleanup();
    }
  });

  it("timeout: proces se zabije a výsledek je timedOut", async () => {
    const f = fakeKaktus("setTimeout(() => {}, 60000);");
    try {
      const t0 = Date.now();
      const r = await defaultRunner({ kaktusDir: f.dir, davkaPath: "d.xml", odpovedPath: "o.xml", timeoutMs: 300 });
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - t0 < 20000, "nesmí čekat na dokončení procesu");
      assert.equal(mapExitCode(r.exitCode, r.timedOut === true).stav, "pad");
    } finally {
      f.cleanup();
    }
  });

  it("exit kód procesu se předá; argumenty se předají doslovně (žádný shell, žádná injection)", async () => {
    const f = fakeKaktus("require('fs').writeFileSync(process.argv[4], JSON.stringify(process.argv.slice(2))); process.exit(3);");
    try {
      const evil = "d & echo PWNED > x.txt ; $(whoami) `id` 'q' %PATH% .xml";
      const out = path.join(f.dir, "args.json");
      const r = await defaultRunner({ kaktusDir: f.dir, davkaPath: evil, odpovedPath: out, timeoutMs: 20000 });
      assert.equal(r.exitCode, 3);
      assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), ["import", evil, out]);
      assert.ok(!fs.existsSync(path.join(f.dir, "x.txt")));
      assert.ok(!fs.existsSync(path.join(process.cwd(), "x.txt")));
    } finally {
      f.cleanup();
    }
  });

  it("kaktusDir s mezerami a metaznaky funguje (cesta se nepředává shellu)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "taxy-sp-"));
    const dir = path.join(base, "Kaktus & spol; (x)");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "kaktus.cjs"), "process.exit(0);");
    try {
      const r = await defaultRunner({ kaktusDir: dir, davkaPath: "d", odpovedPath: "o", timeoutMs: 20000 });
      assert.equal(r.exitCode, 0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("runImport: výjimka z runneru = pád, chybějící odpověď = odpoved null bez chyby", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "taxy-ri-"));
    try {
      const a = await runImport(d, "x", path.join(d, "nic.xml"), { firma: "0001", pocet: 1, runner: () => Promise.reject(new Error("boom")) });
      assert.equal(a.stav, "pad");
      assert.equal(a.odpoved, null);
      const b = await runImport(d, "x", path.join(d, "nic.xml"), { firma: "0001", pocet: 1, runner: () => Promise.resolve({ exitCode: 0 }) });
      assert.equal(b.stav, "zpracovano");
      assert.equal(b.odpoved, null);
      assert.equal(b.odpovedChyba, undefined);
      const c = await runImport(d, "x", path.join(d, "o.xml"), {
        firma: "0001", pocet: 1,
        runner: (v) => { fs.writeFileSync(v.odpovedPath, "<!DOCTYPE x>"); return Promise.resolve({ exitCode: 0 }); },
      });
      assert.equal(c.odpoved, null);
      assert.ok(c.odpovedChyba);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("importDavka: dávka i odpověď v novém mkdtemp adresáři, který se po běhu smaže; stará odpověď se nečte", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "taxy-id-"));
    try {
      const seen: string[] = [];
      const runner = (v: { davkaPath: string; odpovedPath: string }) => {
        seen.push(path.dirname(v.davkaPath));
        assert.equal(path.dirname(v.davkaPath), path.dirname(v.odpovedPath));
        assert.ok(!fs.existsSync(v.odpovedPath), "odpověď musí být nový soubor");
        assert.equal(fs.readFileSync(v.davkaPath, "utf8"), "<x/>");
        return Promise.resolve({ exitCode: 0 });
      };
      const r1 = await importDavka(root, Buffer.from("<x/>"), { firma: "0001", pocet: 1, tmpRoot: root, runner });
      const r2 = await importDavka(root, Buffer.from("<x/>"), { firma: "0001", pocet: 1, tmpRoot: root, runner });
      assert.equal(r1.odpoved, null);
      assert.equal(r2.odpoved, null);
      assert.notEqual(seen[0], seen[1]);
      assert.ok(seen.every((s) => path.basename(s).startsWith("taxy-kaktus-") && path.dirname(s) === root));
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- reconcileDavka (ověření podle DBF) ---------------------------------------------------------

function fak(id: number, poznamka: string, over: Partial<FakturaPrijata> = {}): FakturaPrijata {
  return {
    id, doklad: `FP26${String(id).padStart(4, "0")}`, cisloDodavatele: `C${id}`, variabilniSymbol: "", partnerId: 1,
    datumVystaveni: "2026-10-01", datumZdanitelnehoPlneni: null, datumSplatnosti: null, datumUhrady: null,
    zaklad0: 0, zaklad12: 0, dph12: 0, zaklad21: 0, dph21: 0, celkem: 0, mena: "CZK", kurz: 1, text: "", poznamka, smazano: false,
    ...over,
  };
}
const partner: Dodavatel = { id: 1, nazev: "P", ico: "00000001", dic: null, ulice: "", mesto: "", psc: "", stat: "CZ", ucet: "", poznamka: "", smazano: false };

function imp(stav: ImportVysledek["stav"], odpoved: OdpovedKaktusu | null): ImportVysledek {
  return { stav, exitCode: stav === "zpracovano" ? 0 : 1, odpoved };
}
const odpovedMap = (rows: OdpovedDoklad[]): OdpovedKaktusu => ({ firma: "0001", doklady: new Map(rows.map((r) => [r.poradi, r])) });

describe("reconcileDavka (DBF je zdroj pravdy)", () => {
  const polozky = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("zapsáno = nalezeno v DBF podle TAXY:<id>; zbytek podle odpovědi / neprovedeno", () => {
    const fresh = { dodavatele: [partner], faktury: [fak(1, "TAXY:a"), fak(2, "")] };
    const r = reconcileDavka("0001", polozky, fresh, imp("zpracovano", odpovedMap([
      { poradi: 1, stav: "OK", doklad: "FP260001" }, { poradi: 3, stav: "CHYBA", kod: "E220", zprava: "období" },
    ])));
    assert.equal(r[0]?.stav, "zapsano");
    assert.equal(r[0]?.kaktusDoklad, "FP260001");
    assert.equal(r[1]?.stav, "neprovedeno", "bez odpovědi a bez zápisu = neprovedeno");
    assert.equal(r[2]?.stav, "chyba_kaktusu");
    assert.equal(r[2]?.kod, "E220");
  });

  it("odpověď OK, ale v DBF nic = neprovedeno + varování (nikdy zapsano bez důkazu)", () => {
    const r = reconcileDavka("0001", [{ id: "a" }], { dodavatele: [partner], faktury: [] }, imp("zpracovano", odpovedMap([{ poradi: 1, stav: "OK", doklad: "FP260001" }])));
    assert.equal(r[0]?.stav, "neprovedeno");
    assert.ok(r[0]?.varovani.length);
  });

  it("odpověď CHYBA, ale v DBF je = zapsano s varováním; jiné číslo dokladu = varování", () => {
    const fresh = { dodavatele: [partner], faktury: [fak(1, "TAXY:a"), fak(2, "TAXY:b")] };
    const r = reconcileDavka("0001", [{ id: "a" }, { id: "b" }], fresh, imp("zpracovano", odpovedMap([
      { poradi: 1, stav: "CHYBA", kod: "E999", zprava: "x" }, { poradi: 2, stav: "OK", doklad: "FP269999" },
    ])));
    assert.equal(r[0]?.stav, "zapsano");
    assert.ok(r[0]?.varovani.some((v) => /platí databáze/.test(v)));
    assert.equal(r[1]?.stav, "zapsano");
    assert.equal(r[1]?.kaktusDoklad, "FP260002");
    assert.ok(r[1]?.varovani.some((v) => /platí databáze/.test(v)));
  });

  it("pád / zámek / null import: bez zápisu v DBF je vše neprovedeno; zapsané se přesto uznají", () => {
    const fresh = { dodavatele: [partner], faktury: [fak(1, "TAXY:a")] };
    for (const stav of ["pad", "firma_zamcena", "davka_necitelna", "firma_neexistuje"] as const) {
      const r = reconcileDavka("0001", polozky, fresh, imp(stav, null));
      assert.deepEqual(r.map((x) => x.stav), ["zapsano", "neprovedeno", "neprovedeno"], stav);
    }
    const n = reconcileDavka("0001", polozky, { dodavatele: [], faktury: [] }, null);
    assert.deepEqual(n.map((x) => x.stav), ["neprovedeno", "neprovedeno", "neprovedeno"]);
  });

  it("smazaný záznam se značkou se nepočítá; předpona id (doc_1 vs doc_12) nesmí splést výsledek", () => {
    const fresh = { dodavatele: [partner], faktury: [fak(1, "TAXY:doc_12"), fak(2, "TAXY:doc_1", { smazano: true })] };
    const r = reconcileDavka("0001", [{ id: "doc_1" }, { id: "doc_12" }], fresh, imp("zpracovano", odpovedMap([])));
    assert.equal(r[0]?.stav, "neprovedeno");
    assert.equal(r[1]?.stav, "zapsano");
    assert.equal(r[1]?.kaktusDoklad, "FP260001");
  });

  it("značka u více dokladů = zapsano s varováním o duplicitě", () => {
    const fresh = { dodavatele: [partner], faktury: [fak(1, "TAXY:a"), fak(2, "TAXY:a")] };
    const r = reconcileDavka("0001", [{ id: "a" }], fresh, imp("zpracovano", odpovedMap([])));
    assert.equal(r[0]?.stav, "zapsano");
    assert.ok(r[0]?.varovani.some((v) => /více dokladů/.test(v)));
  });
});
