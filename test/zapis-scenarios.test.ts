// Integrační scénáře zápisu nad kopií simulátoru: dávky, zámek, autorizace, injection, znaky mimo
// CP852, pád importu, dry-run a záložní deduplikace. Vždy se ověřuje skutečný stav DBF.
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { zapis } from "../src/write";
import type { ZapisReport } from "../src/write";
import { defaultRunner } from "../src/kaktus/import";
import type { ImportRunner } from "../src/kaktus/import";
import { main } from "../src/cli";
import { VstupniChyba } from "../src/errors";
import { parseKlienti } from "../src/taxy/input";
import type { Klient } from "../src/taxy/input";
import {
  makeSandbox, mkDoklad, realKlienti, realDoklady, data, byMarker, radek, fakpriBytes, adresarBytes,
  listDir, lockFile, simulator, ROOT,
} from "./helpers";
import type { Sandbox } from "./helpers";

async function withSandbox(fn: (sb: Sandbox) => Promise<void>): Promise<void> {
  const sb = makeSandbox();
  try {
    await fn(sb);
  } finally {
    sb.cleanup();
  }
}

function run(sb: Sandbox, doklady: unknown[], extra: { runner?: ImportRunner; maxDavka?: number; klienti?: Klient[]; dryRun?: boolean } = {}): Promise<ZapisReport> {
  return zapis({
    kaktusDir: sb.kaktusDir, klienti: extra.klienti ?? realKlienti(), doklady, tmpRoot: sb.tmpRoot,
    runner: extra.runner, maxDavka: extra.maxDavka, dryRun: extra.dryRun,
  });
}

/** Počet dokladů v dávce (dávka je Win-1250, pro počítání značek stačí latin1). */
function countDocs(davkaPath: string): number {
  return fs.readFileSync(davkaPath).toString("latin1").split("<FakturaPrijata>").length - 1;
}

function recording(inner: ImportRunner = defaultRunner) {
  const calls: { count: number; odpovedPath: string; odpovedExistedBefore: boolean; bom: boolean; decl: boolean }[] = [];
  const runner: ImportRunner = async (v) => {
    const bytes = fs.readFileSync(v.davkaPath);
    calls.push({
      count: countDocs(v.davkaPath),
      odpovedPath: v.odpovedPath,
      odpovedExistedBefore: fs.existsSync(v.odpovedPath),
      bom: bytes[0] === 0xef || bytes[0] === 0xff || bytes[0] === 0xfe,
      decl: bytes.subarray(0, 60).toString("latin1").startsWith('<?xml version="1.0" encoding="windows-1250"?>'),
    });
    return inner(v);
  };
  return { runner, calls };
}

/** Pád: skutečný import zkrácené dávky (prvních `keep` dokladů), pak podle `mode` zmizí odpověď / výjimka. */
function crashRunner(keep: number, mode: "smaz-odpoved" | "ponech-odpoved", onlyCall = 1) {
  let n = 0;
  const runner: ImportRunner = async (v) => {
    n++;
    if (n !== onlyCall) return defaultRunner(v);
    const text = fs.readFileSync(v.davkaPath).toString("latin1");
    const head = text.slice(0, text.indexOf("<FakturaPrijata>") - 2);
    const blocks = text.match(/ {2}<FakturaPrijata>[\s\S]*?<\/FakturaPrijata>\n/g) ?? [];
    const cut = path.join(path.dirname(v.davkaPath), "zkracena.xml");
    fs.writeFileSync(cut, Buffer.from(`${head}\n${blocks.slice(0, keep).join("")}</KaktusDavka>\n`, "latin1"));
    const r = await defaultRunner({ ...v, davkaPath: cut });
    if (mode === "smaz-odpoved") {
      fs.rmSync(v.odpovedPath, { force: true });
      return { exitCode: 137 };
    }
    return r;
  };
  return { runner, get calls() { return n; } };
}

function many(n: number, prefix = "m", start = 0): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = start; i < start + n; i++) {
    const id = `${prefix}${String(i).padStart(3, "0")}`;
    out.push(mkDoklad(id, {
      cisloDokladu: `C-${id}`,
      dodavatel: { nazev: `Dodavatel ${id}`, ico: String(90990000 + i), dic: "CZ1", ulice: "U 1", mesto: "Brno", psc: "60200", stat: "CZ" },
    }));
  }
  return out;
}

function markerCount(sb: Sandbox, firma: string): number {
  return data(sb, firma).faktury.filter((f) => f.poznamka.startsWith("TAXY:")).length;
}

describe("Dávky > 20 dokladů", () => {
  it("45 dokladů do firmy 0001 = dávky 20+20+5, všechny zapsány právě jednou", async () => {
    await withSandbox(async (sb) => {
      const docs = many(45);
      const pred = data(sb, "0001");
      const rec = recording();
      const rep = await run(sb, docs, { runner: rec.runner });
      assert.deepEqual(rec.calls.map((c) => c.count), [20, 20, 5]);
      assert.ok(rec.calls.every((c) => !c.bom && c.decl), "dávka bez BOM, deklarace windows-1250");
      assert.equal(rep.souhrn.pocty.zapsano, 45);
      const po = data(sb, "0001");
      assert.equal(po.faktury.length, pred.faktury.length + 45);
      assert.equal(po.dodavatele.length, pred.dodavatele.length + 45);
      for (const d of docs) assert.equal(byMarker(po, d.id as string).length, 1, d.id as string);
      assert.deepEqual(listDir(sb.tmpRoot), []);
    });
  });

  it("přesně 20 a 21 dokladů: hranice dávky", async () => {
    await withSandbox(async (sb) => {
      const rec = recording();
      const rep = await run(sb, many(21), { runner: rec.runner });
      assert.deepEqual(rec.calls.map((c) => c.count), [20, 1]);
      assert.equal(rep.souhrn.pocty.zapsano, 21);
      assert.equal(markerCount(sb, "0001"), 21);
    });
  });

  it("maxDavka malé (4): 10 dokladů = 4+4+2; každá odpověď do nového souboru v novém adresáři", async () => {
    await withSandbox(async (sb) => {
      const rec = recording();
      const rep = await run(sb, many(10), { runner: rec.runner, maxDavka: 4 });
      assert.deepEqual(rec.calls.map((c) => c.count), [4, 4, 2]);
      assert.equal(new Set(rec.calls.map((c) => c.odpovedPath)).size, 3, "odpovědi musí mít unikátní cesty");
      assert.ok(rec.calls.every((c) => !c.odpovedExistedBefore), "stará odpověď nesmí existovat");
      assert.ok(rec.calls.every((c) => path.dirname(c.odpovedPath).startsWith(sb.tmpRoot)));
      assert.equal(rep.souhrn.pocty.zapsano, 10);
      assert.equal(markerCount(sb, "0001"), 10);
      assert.deepEqual(listDir(sb.tmpRoot), []);
    });
  });

  it("dávky se dělí po firmách (doklady obou klientů promíchané)", async () => {
    await withSandbox(async (sb) => {
      const a = many(3, "a");
      const b = many(3, "b", 100).map((d) => ({ ...d, klientId: 4180, odberatel: { nazev: "Pekařství", ico: "90581130" } }));
      const rec = recording();
      const rep = await run(sb, [a[0], b[0], a[1], b[1], a[2], b[2]], { runner: rec.runner });
      assert.deepEqual(rec.calls.map((c) => c.count), [3, 3]);
      assert.equal(rep.souhrn.pocty.zapsano, 6);
      assert.equal(markerCount(sb, "0001"), 3);
      assert.equal(markerCount(sb, "0002"), 3);
    });
  });
});

describe("Tolerance E210 a kódy chyb Kaktusu", () => {
  it("rozdíl součtu a Celkem 1 Kč projde, 2 Kč = chyba_kaktusu E210 (a nic v DBF)", async () => {
    await withSandbox(async (sb) => {
      const ok = mkDoklad("e210ok", { celkem: 122 });
      const spatne = mkDoklad("e210bad", { celkem: 123, cisloDokladu: "E210-BAD" });
      const pred = data(sb, "0001");
      const rep = await run(sb, [ok, spatne]);
      assert.equal(radek(rep, "e210ok").stav, "zapsano");
      assert.equal(radek(rep, "e210bad").stav, "chyba_kaktusu");
      assert.equal(radek(rep, "e210bad").kod, "E210");
      const po = data(sb, "0001");
      assert.equal(po.faktury.length, pred.faktury.length + 1);
      assert.equal(byMarker(po, "e210ok")[0]?.celkem, 12200);
      assert.equal(byMarker(po, "e210bad").length, 0);
    });
  });
});

describe("Zamčená firma", () => {
  async function cliSoubory(sb: Sandbox): Promise<{ args: string[]; out: string }> {
    const klienti = path.join(sb.root, "klienti.json");
    const doklady = path.join(sb.root, "doklady.json");
    fs.copyFileSync(path.join(ROOT, "taxy", "klienti.json"), klienti);
    fs.copyFileSync(path.join(ROOT, "taxy", "doklady-k-zapisu.json"), doklady);
    const out = path.join(sb.root, "report.json");
    return { args: ["zapis", "--kaktus", sb.kaktusDir, "--klienti", klienti, "--doklady", doklady, "--out", out], out };
  }
  const ticho = { out: () => {}, err: () => {} };

  it("FIRMA.LCK (simulátor zamknout): 0001 neprovedeno a beze změny, 0002 zapsána, CLI exit 2; po odemknutí doběhne", async () => {
    await withSandbox(async (sb) => {
      simulator(sb, "zamknout", "0001");
      assert.ok(fs.existsSync(lockFile(sb, "0001")));
      const fak1 = fakpriBytes(sb, "0001");
      const adr1 = adresarBytes(sb, "0001");
      const pred2 = data(sb, "0002");
      const { args, out } = await cliSoubory(sb);

      assert.equal(await main(args, ticho), 2);
      const rep = JSON.parse(fs.readFileSync(out, "utf8")) as ZapisReport;
      assert.ok(fakpriBytes(sb, "0001").equals(fak1), "FAKPRI zamčené firmy se nesmí změnit");
      assert.ok(adresarBytes(sb, "0001").equals(adr1), "ADRESAR zamčené firmy se nesmí změnit");
      assert.equal(rep.souhrn.firmy["0001"]?.pocty.neprovedeno, 25, "24 k zápisu + doklad s DUZP 2025, který by dostal E220");
      assert.equal(rep.souhrn.firmy["0001"]?.pocty.zapsano, 0);
      assert.match(rep.souhrn.firmy["0001"]?.preruseno ?? "", /FIRMA\.LCK/);
      assert.equal(rep.souhrn.firmy["0002"]?.pocty.zapsano, 5);
      assert.equal(data(sb, "0002").faktury.length, pred2.faktury.length + 5);
      for (const d of rep.doklady.filter((x) => x.stav === "neprovedeno")) assert.equal(d.firma, "0001");

      simulator(sb, "odemknout", "0001");
      assert.ok(!fs.existsSync(lockFile(sb, "0001")));
      assert.equal(await main(args, ticho), 0);
      const rep2 = JSON.parse(fs.readFileSync(out, "utf8")) as ZapisReport;
      assert.equal(rep2.souhrn.pocty.neprovedeno, 0);
      assert.equal(rep2.souhrn.firmy["0001"]?.pocty.zapsano, 24);
      assert.equal(rep2.souhrn.firmy["0001"]?.pocty.chyba_kaktusu, 1);
      assert.equal(rep2.souhrn.firmy["0002"]?.pocty.zapsano, 0, "firma 0002 už se podruhé nezapisuje");
      assert.equal(markerCount(sb, "0001"), 24);
      assert.equal(markerCount(sb, "0002"), 5);
      assert.deepEqual(listDir(sb.tmpRoot), []);
    });
  });

  it("zámek vzniklý až po předběžné kontrole (těsně před importem): exit 3 simulátoru = neprovedeno, nic nezapsáno", async () => {
    await withSandbox(async (sb) => {
      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const docs = many(5);
      const zamykaciRunner: ImportRunner = (v) => {
        fs.writeFileSync(lockFile(sb, "0001"), "uctarna 1");
        return defaultRunner(v);
      };
      const rep = await run(sb, docs, { runner: zamykaciRunner });
      assert.equal(rep.souhrn.pocty.neprovedeno, 5);
      assert.ok(fakpriBytes(sb, "0001").equals(fak));
      assert.ok(adresarBytes(sb, "0001").equals(adr));
      fs.rmSync(lockFile(sb, "0001"));
      const rep2 = await run(sb, docs);
      assert.equal(rep2.souhrn.pocty.zapsano, 5);
      assert.equal(markerCount(sb, "0001"), 5);
    });
  });

  it("zámek uprostřed více dávek: další dávky téže firmy se nezkoušejí", async () => {
    await withSandbox(async (sb) => {
      let n = 0;
      const rec = recording();
      const runner: ImportRunner = (v) => {
        n++;
        if (n === 2) fs.writeFileSync(lockFile(sb, "0001"), "uctarna 1");
        return rec.runner(v);
      };
      const rep = await run(sb, many(9), { runner, maxDavka: 3 });
      assert.equal(rep.souhrn.pocty.zapsano, 3);
      assert.equal(rep.souhrn.pocty.neprovedeno, 6);
      assert.equal(rec.calls.length, 2, "třetí dávka se nesmí spustit");
      assert.equal(markerCount(sb, "0001"), 3);
    });
  });
});

describe("Autorizace (IDOR)", () => {
  it("cizí klient, nesoulad odběratele, klientId jako text a firma v dokladu se ignorují", async () => {
    await withSandbox(async (sb) => {
      const pred1 = data(sb, "0001");
      const pred2 = data(sb, "0002");
      const fak2 = fakpriBytes(sb, "0002");
      const adr2 = adresarBytes(sb, "0002");
      const docs = [
        // klient 4172 (firma 0001), ale odběratel je IČO firmy 0002
        mkDoklad("a_nesoulad", { odberatel: { nazev: "Pekařství", ico: "90581130" } }),
        // klient 4180 (firma 0002), ale odběratel je IČO firmy 0001
        mkDoklad("a_cizi", { klientId: 4180 }),
        mkDoklad("a_nezname", { klientId: 999 }),
        mkDoklad("a_text", { klientId: "4172" }),
        mkDoklad("a_nula", { klientId: 0 }),
        // správný klient, ale doklad se snaží přesměrovat na jinou firmu
        mkDoklad("a_firma", { firma: "0002", kaktusFirma: "0002", slozka: "0002", odberatel: { nazev: "Truhlářství", ico: "90412761" } }),
      ];
      const rep = await run(sb, docs);
      for (const id of ["a_nesoulad", "a_cizi", "a_nezname", "a_text", "a_nula"]) {
        assert.equal(radek(rep, id).stav, "odmitnuto", id);
        assert.equal(byMarker(data(sb, "0001"), id).length + byMarker(data(sb, "0002"), id).length, 0, id);
      }
      assert.equal(radek(rep, "a_firma").stav, "zapsano");
      assert.equal(radek(rep, "a_firma").firma, "0001");
      assert.equal(byMarker(data(sb, "0001"), "a_firma").length, 1);
      assert.equal(data(sb, "0001").faktury.length, pred1.faktury.length + 1);
      assert.ok(fakpriBytes(sb, "0002").equals(fak2), "do firmy 0002 se nesmí zapsat nic");
      assert.ok(adresarBytes(sb, "0002").equals(adr2));
      assert.equal(data(sb, "0002").faktury.length, pred2.faktury.length);
    });
  });

  it("klient mapovaný na neexistující firmu (0009) nebo s IČO jiným než ve FIRMY.DBF = odmitnuto", async () => {
    await withSandbox(async (sb) => {
      const fak1 = fakpriBytes(sb, "0001");
      const adr1 = adresarBytes(sb, "0001");
      const klienti: Klient[] = [
        { klientId: 4172, nazev: "X", ico: "90412761", kaktusFirma: "0009" },
        { klientId: 4180, nazev: "Y", ico: "90581130", kaktusFirma: "0001" }, // IČO klienta != FIRMY.ICO firmy 0001
      ];
      const docs = [
        mkDoklad("n_firma"),
        mkDoklad("n_ico", { klientId: 4180, odberatel: { nazev: "Y", ico: "90581130" } }),
      ];
      const rep = await run(sb, docs, { klienti });
      assert.equal(radek(rep, "n_firma").stav, "odmitnuto");
      assert.equal(radek(rep, "n_ico").stav, "odmitnuto");
      assert.match(radek(rep, "n_ico").duvod ?? "", /IČO/);
      assert.ok(fakpriBytes(sb, "0001").equals(fak1));
      assert.ok(adresarBytes(sb, "0001").equals(adr1));
    });
  });

  it("kaktusFirma v klienti.json mimo ^\\d{4}$ (../0002, 0002/, 00020, nový řádek) = VstupniChyba", () => {
    for (const bad of ["../0002", "0002/", "00020", "0002\n", "", "abcd", "..\\0002", " 0002"]) {
      assert.throws(
        () => parseKlienti({ klienti: [{ klientId: 1, nazev: "A", ico: "1", kaktusFirma: bad }] }),
        VstupniChyba,
        JSON.stringify(bad),
      );
    }
    assert.throws(() => parseKlienti({ klienti: [
      { klientId: 1, nazev: "A", ico: "1", kaktusFirma: "0001" },
      { klientId: 2, nazev: "B", ico: "2", kaktusFirma: "0001" },
    ] }), VstupniChyba, "jedna firma dvěma klientům");
    assert.throws(() => parseKlienti({ klienti: [
      { klientId: 1, nazev: "A", ico: "1", kaktusFirma: "0001" },
      { klientId: 1, nazev: "B", ico: "2", kaktusFirma: "0002" },
    ] }), VstupniChyba, "duplicitní klientId");
  });

  it("CLI: klienti.json s kaktusFirma ../0002 = exit 1, nic nezapsáno, report nevznikne", async () => {
    await withSandbox(async (sb) => {
      const klienti = path.join(sb.root, "klienti.json");
      const doklady = path.join(sb.root, "doklady.json");
      const out = path.join(sb.root, "r.json");
      fs.writeFileSync(klienti, JSON.stringify({ klienti: [{ klientId: 4172, nazev: "T", ico: "90412761", kaktusFirma: "../0002" }] }));
      fs.writeFileSync(doklady, JSON.stringify([mkDoklad("x1")]));
      const fak2 = fakpriBytes(sb, "0002");
      const fak1 = fakpriBytes(sb, "0001");
      const code = await main(["zapis", "--kaktus", sb.kaktusDir, "--klienti", klienti, "--doklady", doklady, "--out", out], { out: () => {}, err: () => {} });
      assert.equal(code, 1);
      assert.ok(!fs.existsSync(out));
      assert.ok(fakpriBytes(sb, "0002").equals(fak2));
      assert.ok(fakpriBytes(sb, "0001").equals(fak1));
    });
  });
});

describe("XML injection a escapování (integračně, text v DBF doslovně)", () => {
  it("payloady </Text><Celkem>1</Celkem>, &amp;, ]]>, &#0;, řídicí znaky, <září>, Novák & syn", async () => {
    await withSandbox(async (sb) => {
      const base = (id: string, popis: string, nazev: string, extra: Record<string, unknown> = {}, ulice = "Ulice 1") => {
        const d = mkDoklad(id, {
          popis, cisloDokladu: (extra.cislo as string | undefined) ?? `INJ-${id}`,
          rozpisDph: [{ sazba: 21, zaklad: 100, dph: 21 }], celkem: 121,
        });
        d.dodavatel = { nazev, ico: String(90980000 + id.length * 7 + (id.codePointAt(id.length - 1) ?? 0)), dic: "CZ1", ulice, mesto: "Praha", psc: "11000", stat: "CZ" };
        return d;
      };
      const docs = [
        base("ia", "</Text><Celkem>1</Celkem>", "Novák & syn", { cislo: "&amp;1" }, "</Dodavatel><Dodavatel>"),
        base("ib", "]]> &#0; &amp;", "<září>"),
        base("ic", "a\u0000b\u0001c\u001fd\te", "Q\"uote's"),
        base("id", "<!-- x --><![CDATA[y]]>", "&#x41;&lt;&foo;"),
        base("ie", "<?xml version=\"1.0\"?>", "x</Nazev><ICO>1</ICO>"),
      ];
      const pred = data(sb, "0001");
      const rep = await run(sb, docs);
      assert.equal(rep.souhrn.pocty.zapsano, 5, JSON.stringify(rep.doklady.map((d) => [d.id, d.stav, d.duvod])));
      const po = data(sb, "0001");
      assert.equal(po.faktury.length, pred.faktury.length + 5);
      const text = (id: string) => byMarker(po, id)[0];
      const partner = (id: string) => po.dodavatele.find((p) => p.id === text(id)?.partnerId);

      assert.equal(text("ia")?.text, "</Text><Celkem>1</Celkem>");
      assert.equal(text("ia")?.cisloDodavatele, "&amp;1");
      assert.equal(partner("ia")?.nazev, "Novák & syn");
      assert.equal(partner("ia")?.ulice, "</Dodavatel><Dodavatel>");
      assert.equal(text("ib")?.text, "]]> &#0; &amp;");
      assert.equal(partner("ib")?.nazev, "<září>");
      assert.equal(text("ic")?.text, "abcd e");
      assert.equal(partner("ic")?.nazev, "Q\"uote's");
      assert.ok(radek(rep, "ic").varovani.some((v) => /řídicí/.test(v)));
      assert.equal(text("id")?.text, "<!-- x --><![CDATA[y]]>");
      assert.equal(partner("id")?.nazev, "&#x41;&lt;&foo;");
      assert.equal(text("ie")?.text, "<?xml version=\"1.0\"?>");
      assert.equal(partner("ie")?.nazev, "x</Nazev><ICO>1</ICO>");
      // částka se payloadem nezměnila, značka je nedotčená
      for (const id of ["ia", "ib", "ic", "id", "ie"]) {
        assert.equal(text(id)?.celkem, 12100, id);
        assert.equal(text(id)?.zaklad21, 10000, id);
        assert.equal(text(id)?.dph21, 2100, id);
        assert.equal(text(id)?.poznamka, `TAXY:${id}`, id);
        assert.equal(text(id)?.mena, "CZK", id);
      }
    });
  });

  it("neplatný ID dokladu (injection přes id / značku) se odmítne před zápisem", async () => {
    await withSandbox(async (sb) => {
      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const docs = ["a<b", "x:y", "a b", "</Poznamka>", "", "a".repeat(41), "../x", "a\u0000b"].map((id) => mkDoklad(id));
      const rep = await run(sb, docs);
      assert.equal(rep.souhrn.pocty.odmitnuto, docs.length);
      assert.ok(fakpriBytes(sb, "0001").equals(fak));
      assert.ok(adresarBytes(sb, "0001").equals(adr));
    });
  });
});

describe("Znaky mimo CP852 (€ „ “ – →)", () => {
  it("náhrada + varování, v DBF bez ? tam, kde se transliterovalo; neznámé znaky = ? a varování", async () => {
    await withSandbox(async (sb) => {
      const d = mkDoklad("zn1", { popis: "Cena 5 € „A“ – B → C" });
      d.dodavatel = { nazev: "Café Señor – „Bar“", ico: "90970001", dic: null, ulice: "Ulice → 1", mesto: "Señor 中😀", psc: "11000", stat: "CZ" };
      const rep = await run(sb, [d]);
      assert.equal(radek(rep, "zn1").stav, "zapsano");
      const po = data(sb, "0001");
      const f = byMarker(po, "zn1")[0];
      const p = po.dodavatele.find((x) => x.id === f?.partnerId);
      assert.equal(f?.text, "Cena 5 EUR \"A\" - B -> C");
      assert.equal(p?.nazev, "Café Senor - \"Bar\"");
      assert.equal(p?.ulice, "Ulice -> 1");
      assert.equal(p?.mesto, "Senor ??", "dva netransliterovatelné znaky = dvě ?");
      const v = radek(rep, "zn1").varovani.join("\n");
      assert.match(v, /Text dokladu: znaky.*„€“ za „EUR“/);
      assert.match(v, /Text dokladu.*„→“ za „->“/);
      assert.match(v, /Název dodavatele.*„–“ za „-“/);
      assert.match(v, /Město dodavatele.*znakem \? \(počet: 2\)/);
      assert.ok(!(f?.text ?? "").includes("?"));
    });
  });

  it("český text s diakritikou se NEtransliteruje (Win-1250 ∩ CP852 zůstane)", async () => {
    await withSandbox(async (sb) => {
      const t = "Příliš žluťoučký kůň úpěl ďábelské ódy ĚŠČŘŽÝÁÍÉŇŤĎÚŮ";
      const d = mkDoklad("zn2", { popis: t.slice(0, 50) });
      const rep = await run(sb, [d]);
      assert.equal(radek(rep, "zn2").stav, "zapsano");
      assert.deepEqual(radek(rep, "zn2").varovani, []);
      assert.equal(byMarker(data(sb, "0001"), "zn2")[0]?.text, t.slice(0, 50));
    });
  });

  it("ořezy polí: CISLODOD 20, VS 10, TEXT 50, město 30 + varování; v DBF přesně ořezané hodnoty", async () => {
    await withSandbox(async (sb) => {
      const d = mkDoklad("or1", {
        cisloDokladu: "ABCDEFGHIJ0123456789XYZ", variabilniSymbol: "12345678901234", popis: "t".repeat(80),
      });
      d.dodavatel = { nazev: "N".repeat(64), ico: "90970002", dic: "CZ" + "9".repeat(20), ulice: "U".repeat(60), mesto: "M".repeat(40), psc: "1100099", stat: "CZ" };
      const rep = await run(sb, [d]);
      assert.equal(radek(rep, "or1").stav, "zapsano");
      const po = data(sb, "0001");
      const f = byMarker(po, "or1")[0];
      const p = po.dodavatele.find((x) => x.id === f?.partnerId);
      assert.equal(f?.cisloDodavatele, "ABCDEFGHIJ0123456789");
      assert.equal(f?.variabilniSymbol, "1234567890");
      assert.equal(f?.text, "t".repeat(50));
      assert.equal(p?.nazev, "N".repeat(40));
      assert.equal(p?.mesto, "M".repeat(30));
      assert.equal(p?.ulice, "U".repeat(40));
      assert.equal(p?.psc, "110009");
      assert.equal(radek(rep, "or1").varovani.filter((v) => /ořezáno/.test(v)).length >= 6, true, radek(rep, "or1").varovani.join("|"));
    });
  });
});

describe("Pád importu uprostřed", () => {
  it("runner zkrátí dávku na 3 z 8 a smaže odpověď: 3x zapsano (podle DBF), 5x neprovedeno; opakovaný běh dopíše jen zbytek", async () => {
    await withSandbox(async (sb) => {
      const docs = many(8);
      const pred = data(sb, "0001");
      const crash = crashRunner(3, "smaz-odpoved");
      const rep = await run(sb, docs, { runner: crash.runner });
      assert.deepEqual(rep.doklady.map((d) => d.stav), [
        "zapsano", "zapsano", "zapsano", "neprovedeno", "neprovedeno", "neprovedeno", "neprovedeno", "neprovedeno",
      ]);
      assert.match(rep.souhrn.firmy["0001"]?.preruseno ?? "", /nedokončil|pád/i);
      const po = data(sb, "0001");
      assert.equal(po.faktury.length, pred.faktury.length + 3);
      for (const [i, d] of docs.entries()) {
        const hits = byMarker(po, d.id as string);
        assert.equal(hits.length, i < 3 ? 1 : 0, d.id as string);
        if (i < 3) assert.equal(radek(rep, d.id as string).kaktusDoklad, hits[0]?.doklad);
      }

      const rep2 = await run(sb, docs);
      assert.deepEqual(rep2.doklady.map((d) => d.stav), [
        "jiz_zapsano", "jiz_zapsano", "jiz_zapsano", "zapsano", "zapsano", "zapsano", "zapsano", "zapsano",
      ]);
      const po2 = data(sb, "0001");
      assert.equal(po2.faktury.length, pred.faktury.length + 8);
      for (const d of docs) assert.equal(byMarker(po2, d.id as string).length, 1, `${d.id} nesmí být dvakrát`);
      assert.equal(po2.dodavatele.length, pred.dodavatele.length + 8, "žádný duplicitní partner");
      assert.deepEqual(listDir(sb.tmpRoot), []);
    });
  });

  it("odpověď zůstane, ale je částečná (zkrácená dávka, exit 0): chybějící Doklad = neprovedeno, ne zapsano", async () => {
    await withSandbox(async (sb) => {
      const docs = many(5);
      const rep = await run(sb, docs, { runner: crashRunner(2, "ponech-odpoved").runner });
      assert.deepEqual(rep.doklady.map((d) => d.stav), ["zapsano", "zapsano", "neprovedeno", "neprovedeno", "neprovedeno"]);
      assert.equal(markerCount(sb, "0001"), 2);
      const rep2 = await run(sb, docs);
      assert.equal(rep2.souhrn.pocty.jiz_zapsano, 2);
      assert.equal(rep2.souhrn.pocty.zapsano, 3);
      assert.equal(markerCount(sb, "0001"), 5);
    });
  });

  it("pád druhé dávky ze tří: první dávka zůstane zapsaná, třetí se nespustí", async () => {
    await withSandbox(async (sb) => {
      const docs = many(8);
      const crash = crashRunner(1, "smaz-odpoved", 2);
      const rep = await run(sb, docs, { runner: crash.runner, maxDavka: 3 });
      assert.deepEqual(rep.doklady.map((d) => d.stav), [
        "zapsano", "zapsano", "zapsano", "zapsano", "neprovedeno", "neprovedeno", "neprovedeno", "neprovedeno",
      ]);
      assert.equal(crash.calls, 2);
      assert.equal(markerCount(sb, "0001"), 4);
      const rep2 = await run(sb, docs, { maxDavka: 3 });
      assert.equal(rep2.souhrn.pocty.jiz_zapsano, 4);
      assert.equal(rep2.souhrn.pocty.zapsano, 4);
      assert.equal(markerCount(sb, "0001"), 8);
    });
  });

  it("pád v jedné firmě nezastaví druhou firmu", async () => {
    await withSandbox(async (sb) => {
      const a = many(3, "a");
      const b = many(3, "b", 100).map((d) => ({ ...d, klientId: 4180, odberatel: { nazev: "P", ico: "90581130" } }));
      const rep = await run(sb, [...a, ...b], { runner: crashRunner(0, "smaz-odpoved").runner });
      // první volání (firma 0001) spadne s prázdnou dávkou, druhá firma proběhne normálně
      assert.equal(rep.souhrn.firmy["0001"]?.pocty.neprovedeno, 3);
      assert.equal(rep.souhrn.firmy["0002"]?.pocty.zapsano, 3);
      assert.equal(markerCount(sb, "0001"), 0);
      assert.equal(markerCount(sb, "0002"), 3);
    });
  });

  it("výjimka z runneru = pád: nic zapsáno, report vznikne, doklady neprovedeno, DBF beze změny", async () => {
    await withSandbox(async (sb) => {
      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const rep = await run(sb, many(4), { runner: () => Promise.reject(new Error("boom")) });
      assert.equal(rep.souhrn.pocty.neprovedeno, 4);
      assert.ok(fakpriBytes(sb, "0001").equals(fak));
      assert.ok(adresarBytes(sb, "0001").equals(adr));
      assert.deepEqual(listDir(sb.tmpRoot), []);
    });
  });

  it("timeout (timedOut) = neprovedeno, opakování doběhne", async () => {
    await withSandbox(async (sb) => {
      const docs = many(3);
      const rep = await run(sb, docs, { runner: () => Promise.resolve({ exitCode: null, timedOut: true }) });
      assert.equal(rep.souhrn.pocty.neprovedeno, 3);
      assert.match(rep.souhrn.firmy["0001"]?.preruseno ?? "", /časový limit/);
      assert.equal(markerCount(sb, "0001"), 0);
      const rep2 = await run(sb, docs);
      assert.equal(rep2.souhrn.pocty.zapsano, 3);
    });
  });

  it("pád PO zápisu (import doběhl, ale runner hlásí kill a odpověď chybí): zapsané doklady jsou zapsano podle DBF", async () => {
    await withSandbox(async (sb) => {
      const docs = many(4);
      const runner: ImportRunner = async (v) => {
        await defaultRunner(v);
        fs.rmSync(v.odpovedPath, { force: true });
        return { exitCode: null };
      };
      const rep = await run(sb, docs, { runner });
      assert.equal(rep.souhrn.pocty.zapsano, 4, "DBF je zdroj pravdy");
      assert.equal(markerCount(sb, "0001"), 4);
      const rep2 = await run(sb, docs);
      assert.equal(rep2.souhrn.pocty.jiz_zapsano, 4);
      assert.equal(markerCount(sb, "0001"), 4);
    });
  });

  it("padělaná odpověď: OK bez zápisu v DBF = neprovedeno; CHYBA při zápisu v DBF = zapsano s varováním", async () => {
    await withSandbox(async (sb) => {
      const lhar: ImportRunner = async (v) => {
        fs.writeFileSync(v.odpovedPath, '<?xml version="1.0" encoding="windows-1250"?>\n<KaktusOdpoved firma="0001">\n  <Doklad poradi="1" stav="OK" doklad="FP269999"/>\n</KaktusOdpoved>\n');
        return { exitCode: 0 };
      };
      const fak = fakpriBytes(sb, "0001");
      const rep = await run(sb, many(1), { runner: lhar });
      assert.equal(rep.doklady[0]?.stav, "neprovedeno");
      assert.ok(rep.doklady[0]?.varovani.some((v) => /databázi není/.test(v)));
      assert.ok(fakpriBytes(sb, "0001").equals(fak));

      const lhar2: ImportRunner = async (v) => {
        const r = await defaultRunner(v);
        fs.writeFileSync(v.odpovedPath, '<?xml version="1.0" encoding="windows-1250"?>\n<KaktusOdpoved firma="0001">\n  <Doklad poradi="1" stav="CHYBA" kod="E999" zprava="x"/>\n</KaktusOdpoved>\n');
        return r;
      };
      const rep2 = await run(sb, many(1, "q"), { runner: lhar2 });
      assert.equal(rep2.doklady[0]?.stav, "zapsano");
      assert.ok(rep2.doklady[0]?.varovani.some((v) => /platí databáze/.test(v)));
    });
  });

  it("odpověď s DOCTYPE/ENTITY (XXE) se nepoužije, výsledek určí DBF", async () => {
    await withSandbox(async (sb) => {
      const runner: ImportRunner = async (v) => {
        const r = await defaultRunner(v);
        fs.writeFileSync(v.odpovedPath, '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><KaktusOdpoved firma="0001"><Doklad poradi="1" stav="CHYBA" kod="E999" zprava="&a;"/></KaktusOdpoved>');
        return r;
      };
      const rep = await run(sb, many(2), { runner });
      assert.equal(rep.souhrn.pocty.zapsano, 2);
      assert.equal(markerCount(sb, "0001"), 2);
    });
  });
});

describe("--dry-run", () => {
  it("nemění DBF, nespouští import (ani nevyžaduje kaktus.cjs), doklady k zápisu mají k_zapisu", async () => {
    await withSandbox(async (sb) => {
      const f1 = fakpriBytes(sb, "0001");
      const f2 = fakpriBytes(sb, "0002");
      const a1 = adresarBytes(sb, "0001");
      const a2 = adresarBytes(sb, "0002");
      const rep = await run(sb, realDoklady(), { runner: () => Promise.reject(new Error("runner se nesmí volat")), dryRun: true });
      assert.equal(rep.rezim, "dry-run");
      assert.equal(rep.souhrn.pocty.k_zapisu, 30, "29 zapsatelných + DUZP 2025 (E220 až v Kaktusu)");
      assert.equal(rep.souhrn.pocty.odmitnuto, 4);
      assert.equal(rep.souhrn.pocty.jiz_zapsano, 3);
      assert.equal(rep.souhrn.pocty.zapsano, 0);
      assert.equal(rep.souhrn.pocty.neprovedeno, 0);
      assert.ok(fakpriBytes(sb, "0001").equals(f1));
      assert.ok(fakpriBytes(sb, "0002").equals(f2));
      assert.ok(adresarBytes(sb, "0001").equals(a1));
      assert.ok(adresarBytes(sb, "0002").equals(a2));
      assert.deepEqual(listDir(sb.tmpRoot), []);
      fs.rmSync(path.join(sb.kaktusDir, "kaktus.cjs"));
      const rep2 = await run(sb, realDoklady(), { dryRun: true });
      assert.equal(rep2.souhrn.pocty.k_zapisu, 30);
    });
  });

  it("CLI --dry-run: exit 0, report zapsán, DBF beze změny", async () => {
    await withSandbox(async (sb) => {
      const klienti = path.join(sb.root, "k.json");
      const doklady = path.join(sb.root, "d.json");
      const out = path.join(sb.root, "r.json");
      fs.copyFileSync(path.join(ROOT, "taxy", "klienti.json"), klienti);
      fs.copyFileSync(path.join(ROOT, "taxy", "doklady-k-zapisu.json"), doklady);
      const f1 = fakpriBytes(sb, "0001");
      const lines: string[] = [];
      const code = await main(["zapis", "--kaktus", sb.kaktusDir, "--klienti", klienti, "--doklady", doklady, "--out", out, "--dry-run"], { out: (t) => lines.push(t), err: (t) => lines.push(t) });
      assert.equal(code, 0);
      assert.equal((JSON.parse(fs.readFileSync(out, "utf8")) as ZapisReport).rezim, "dry-run");
      assert.ok(fakpriBytes(sb, "0001").equals(f1));
      assert.ok(lines.join("\n").includes("Zkušební běh"));
    });
  });
});

describe("Záložní deduplikace (ručně zadané doklady bez TAXY:)", () => {
  it("shoda CISLODOD + IČO i při jiném názvu a VS: jiz_zapsano, DBF beze změny", async () => {
    await withSandbox(async (sb) => {
      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const haje = mkDoklad("bk_haje", { cisloDokladu: "NAJ-2026-09", variabilniSymbol: "999999" });
      haje.dodavatel = { nazev: "OBEC HÁJE - jiný zápis", ico: "00242659", dic: null, ulice: "Jinde 1", mesto: "Háje", psc: "26101", stat: "CZ" };
      const cap = mkDoklad("bk_cap", { cisloDokladu: "2026-0931" });
      cap.dodavatel = { nazev: "Čáp", ico: "90100026", dic: null, ulice: null, mesto: null, psc: null, stat: null };
      const rep = await run(sb, [haje, cap]);
      assert.equal(radek(rep, "bk_haje").stav, "jiz_zapsano");
      assert.equal(radek(rep, "bk_haje").kaktusDoklad, "FP260042");
      assert.equal(radek(rep, "bk_cap").stav, "jiz_zapsano");
      assert.equal(radek(rep, "bk_cap").kaktusDoklad, "FP260045");
      assert.ok(fakpriBytes(sb, "0001").equals(fak));
      assert.ok(adresarBytes(sb, "0001").equals(adr));
    });
  });

  it("stejné číslo dokladu od JINÉHO dodavatele není duplicita", async () => {
    await withSandbox(async (sb) => {
      const d = mkDoklad("bk_jiny", { cisloDokladu: "NAJ-2026-09" });
      const rep = await run(sb, [d]);
      assert.equal(radek(rep, "bk_jiny").stav, "zapsano");
      assert.equal(byMarker(data(sb, "0001"), "bk_jiny").length, 1);
    });
  });

  it("stejné číslo a dodavatel ve FIRMĚ 0002 neovlivní firmu 0001 (dedup je po firmách)", async () => {
    await withSandbox(async (sb) => {
      // FV-2609-0188 / Mlýn Perner (90200012) je v 0002; v 0001 stejný doklad není
      const d = mkDoklad("bk_perner", { cisloDokladu: "FV-2609-0188" });
      d.dodavatel = { nazev: "Mlýn Perner a.s.", ico: "90200012", dic: "CZ90200012", ulice: "Mlýnská 1", mesto: "Svijany", psc: "46346", stat: "CZ" };
      const rep = await run(sb, [d]);
      assert.equal(radek(rep, "bk_perner").stav, "zapsano");
      assert.equal(byMarker(data(sb, "0001"), "bk_perner").length, 1);
    });
  });

  it("duplicita ve vstupu bez IČO (shoda názvu) a s mezerami/oříznutím čísla", async () => {
    await withSandbox(async (sb) => {
      const a = mkDoklad("dv_a", { cisloDokladu: "  X-1  " });
      a.dodavatel = { nazev: "Bez ICO s.r.o.", ico: null, dic: null, ulice: null, mesto: null, psc: null, stat: null };
      const b = mkDoklad("dv_b", { cisloDokladu: "X-1" });
      b.dodavatel = { nazev: "Bez ICO s.r.o.", ico: null, dic: null, ulice: null, mesto: null, psc: null, stat: null };
      const rep = await run(sb, [a, b]);
      assert.equal(radek(rep, "dv_a").stav, "zapsano");
      assert.equal(radek(rep, "dv_b").stav, "odmitnuto");
      const po = data(sb, "0001");
      assert.equal(po.faktury.filter((f) => f.cisloDodavatele === "X-1").length, 1);
      assert.equal(byMarker(po, "dv_b").length, 0);
    });
  });

  it("opakované id dokladu ve vstupu: druhý výskyt odmitnuto, zapsáno jednou", async () => {
    await withSandbox(async (sb) => {
      const a = mkDoklad("same");
      const b = mkDoklad("same", { cisloDokladu: "JINE-CISLO" });
      const rep = await run(sb, [a, b]);
      assert.equal(rep.doklady[0]?.stav, "zapsano");
      assert.equal(rep.doklady[1]?.stav, "odmitnuto");
      assert.equal(byMarker(data(sb, "0001"), "same").length, 1);
    });
  });
});
