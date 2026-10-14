// Regresní testy po review R1–R6 (integrační, nad kopií `kaktus/` v mkdtemp; ověřuje se skutečný stav DBF).
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
import type { Klient } from "../src/taxy/input";
import {
  makeSandbox, mkDoklad, realKlienti, realDoklad, data, byMarker, radek, fakpriBytes, adresarBytes,
  listDir, lockFile, ROOT,
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

function run(sb: Sandbox, doklady: unknown[], extra: { runner?: ImportRunner; maxDavka?: number; klienti?: Klient[] } = {}): Promise<ZapisReport> {
  return zapis({
    kaktusDir: sb.kaktusDir, klienti: extra.klienti ?? realKlienti(), doklady, tmpRoot: sb.tmpRoot,
    runner: extra.runner, maxDavka: extra.maxDavka,
  });
}

function dod(over: Record<string, unknown>): Record<string, unknown> {
  return { nazev: "X", ico: null, dic: "CZ1", ulice: "U 1", mesto: "Brno", psc: "60200", stat: "CZ", ...over };
}

function markerCount(sb: Sandbox, firma: string): number {
  return data(sb, firma).faktury.filter((f) => f.poznamka.startsWith("TAXY:")).length;
}

function unchanged(sb: Sandbox, firma: string, fak: Buffer, adr: Buffer): void {
  assert.ok(fakpriBytes(sb, firma).equals(fak), `FAKPRI ${firma} se změnil`);
  assert.ok(adresarBytes(sb, firma).equals(adr), `ADRESAR ${firma} se změnil`);
}

/** Fixture: v KOPII FAKPRI.DBF označí záznam s daným číslem dokladu jako smazaný (bajt příznaku `*`). */
function smazZaznam(sb: Sandbox, firma: string, doklad: string): void {
  const file = path.join(sb.kaktusDir, "DATA", firma, "FAKPRI.DBF");
  const buf = fs.readFileSync(file);
  const headerLen = buf.readUInt16LE(8);
  const recLen = buf.readUInt16LE(10);
  const count = buf.readUInt32LE(4);
  let done = false;
  for (let i = 0; i < count; i++) {
    const off = headerLen + i * recLen;
    if (buf.subarray(off + 9, off + 19).toString("latin1").trim() === doklad) {
      assert.equal(buf[off], 0x20, "záznam už je smazaný");
      buf[off] = 0x2a;
      done = true;
    }
  }
  assert.ok(done, `záznam ${doklad} nenalezen`);
  fs.writeFileSync(file, buf);
}

describe("R1: záložní shoda, když IČO chybí na jedné straně", () => {
  it("doc_00a5091cef s novým id bez IČO dodavatele = jiz_zapsano FP260042, FAKPRI i ADRESAR beze změny", async () => {
    await withSandbox(async (sb) => {
      const d = realDoklad("doc_00a5091cef");
      d.id = "doc_nove_bez_ico";
      (d.dodavatel as Record<string, unknown>).ico = null;
      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const rep = await run(sb, [d]);
      assert.equal(radek(rep, "doc_nove_bez_ico").stav, "jiz_zapsano");
      assert.equal(radek(rep, "doc_nove_bez_ico").kaktusDoklad, "FP260042");
      unchanged(sb, "0001", fak, adr);
    });
  });

  it("doklad s IČO proti partnerovi bez IČO se stejným názvem (Holz Bauer, ID 16, FP260028) = jiz_zapsano", async () => {
    await withSandbox(async (sb) => {
      const pred = data(sb, "0001");
      const holz = pred.faktury.find((f) => f.partnerId === 16 && !f.smazano);
      assert.equal(holz?.doklad, "FP260028");
      const d = mkDoklad("holz_ico", {
        cisloDokladu: holz?.cisloDodavatele,
        dodavatel: dod({ nazev: "Holz Bauer GmbH", ico: "90111222", dic: "DE812345678" }),
      });
      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const rep = await run(sb, [d]);
      assert.equal(radek(rep, "holz_ico").stav, "jiz_zapsano");
      assert.equal(radek(rep, "holz_ico").kaktusDoklad, "FP260028");
      unchanged(sb, "0001", fak, adr);
    });
  });

  it("dva vstupní doklady téhož dodavatele a čísla, jeden s IČO a druhý bez (v obou pořadích) = zapsán jen jeden", async () => {
    for (const poradi of ["s-ico-prvni", "bez-ico-prvni"]) {
      await withSandbox(async (sb) => {
        const nazev = "Nový Dodavatel Alfa s.r.o.";
        const sIco = mkDoklad("dup_ico", { cisloDokladu: "DUP-1", dodavatel: dod({ nazev, ico: "90555111" }) });
        const bez = mkDoklad("dup_bez", { cisloDokladu: "DUP-1", dodavatel: dod({ nazev, ico: null }) });
        const pred = data(sb, "0001");
        const rep = await run(sb, poradi === "s-ico-prvni" ? [sIco, bez] : [bez, sIco]);
        const po = data(sb, "0001");
        assert.equal(po.faktury.length, pred.faktury.length + 1, poradi);
        assert.equal(byMarker(po, "dup_ico").length + byMarker(po, "dup_bez").length, 1, poradi);
        assert.equal(rep.souhrn.pocty.zapsano, 1, poradi);
        assert.equal(rep.souhrn.pocty.odmitnuto, 1, poradi);
        assert.equal(po.dodavatele.length, pred.dodavatele.length + 1, poradi);
      });
    }
  });
});

describe("R2: smazaný záznam s naší značkou", () => {
  it("zapsaný a pak v Kaktusu smazaný doklad = odmitnuto, žádný nový záznam ani partner", async () => {
    await withSandbox(async (sb) => {
      const d = mkDoklad("smazany1", { cisloDokladu: "SM-1" });
      const rep1 = await run(sb, [d]);
      assert.equal(radek(rep1, "smazany1").stav, "zapsano");
      const fp = radek(rep1, "smazany1").kaktusDoklad as string;
      smazZaznam(sb, "0001", fp);
      assert.equal(byMarker(data(sb, "0001"), "smazany1").length, 0);

      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const rep2 = await run(sb, [d]);
      assert.equal(radek(rep2, "smazany1").stav, "odmitnuto");
      assert.match(radek(rep2, "smazany1").duvod ?? "", /smazán/);
      assert.equal(rep2.souhrn.pocty.zapsano, 0);
      unchanged(sb, "0001", fak, adr);
    });
  });

  it("smazaný ruční záznam bez značky (Kuběna FV26001877) se dál zapíše s varováním o smazaném dokladu", async () => {
    await withSandbox(async (sb) => {
      const pred = data(sb, "0001");
      assert.ok(pred.faktury.some((f) => f.smazano && f.cisloDodavatele === "FV26001877"), "fixture: smazaný Kuběna");
      const rep = await run(sb, [realDoklad("doc_61ed535421")]);
      const r = radek(rep, "doc_61ed535421");
      assert.equal(r.stav, "zapsano");
      assert.ok(r.varovani.some((v) => /smazaný doklad/.test(v)));
      const po = data(sb, "0001");
      assert.equal(po.faktury.length, pred.faktury.length + 1);
      assert.equal(byMarker(po, "doc_61ed535421").length, 1);
    });
  });
});

describe("R3: cíl reportu a výsledek po importu (CLI)", () => {
  function setup(sb: Sandbox, doklady: unknown[]): { base: string[]; fak: Buffer; adr: Buffer } {
    fs.copyFileSync(path.join(ROOT, "taxy", "klienti.json"), path.join(sb.root, "klienti.json"));
    fs.writeFileSync(path.join(sb.root, "doklady.json"), JSON.stringify(doklady));
    return {
      base: ["zapis", "--kaktus", sb.kaktusDir, "--klienti", path.join(sb.root, "klienti.json"), "--doklady", path.join(sb.root, "doklady.json")],
      fak: fakpriBytes(sb, "0001"),
      adr: adresarBytes(sb, "0001"),
    };
  }
  const cap = () => {
    const lines: string[] = [];
    return { lines, io: { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) } };
  };

  it("--out je adresář = exit 1, nic nezapsáno", async () => {
    await withSandbox(async (sb) => {
      const s = setup(sb, [mkDoklad("o1")]);
      const dir = path.join(sb.root, "slozka");
      fs.mkdirSync(dir);
      assert.equal(await main([...s.base, "--out", dir], cap().io), 1);
      unchanged(sb, "0001", s.fak, s.adr);
      assert.ok(fs.statSync(dir).isDirectory());
    });
  });

  it("--out s neexistujícím rodičem = exit 1, nic nezapsáno a složka se nevytvoří", async () => {
    await withSandbox(async (sb) => {
      const s = setup(sb, [mkDoklad("o2")]);
      assert.equal(await main([...s.base, "--out", path.join(sb.root, "neni", "report.json")], cap().io), 1);
      unchanged(sb, "0001", s.fak, s.adr);
      assert.ok(!fs.existsSync(path.join(sb.root, "neni")));
    });
  });

  it("zápis reportu selže až po importu (podvržený fs.renameSync) = exit 2, souhrn na stdout, doklad v DBF", async () => {
    await withSandbox(async (sb) => {
      const s = setup(sb, [mkDoklad("o3", { cisloDokladu: "O3-1" })]);
      fs.mkdirSync(path.join(sb.root, "out"));
      const out = path.join(sb.root, "out", "report.json");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const realFs = require("node:fs") as typeof fs;
      const puvodni = realFs.renameSync;
      realFs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
        if (String(b) === out) throw new Error("simulované selhání zápisu");
        return puvodni(a, b);
      }) as typeof fs.renameSync;
      const c = cap();
      let kod: number;
      try {
        kod = await main([...s.base, "--out", out], c.io);
      } finally {
        realFs.renameSync = puvodni;
      }
      assert.equal(kod, 2);
      assert.ok(!fs.existsSync(out));
      const txt = c.lines.join("\n");
      assert.match(txt, /zapsáno 1/);
      assert.match(txt, /o3: zapsano FP26/);
      assert.match(txt, /simulované selhání zápisu/);
      assert.equal(byMarker(data(sb, "0001"), "o3").length, 1);
    });
  });
});

describe("R4: nečekaná výjimka po doběhlém importu", () => {
  it("selhání úklidu tmp adresáře (podvržený fs.rmSync) nepřebije výsledek: zapsano, doklady v DBF", async () => {
    await withSandbox(async (sb) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const realFs = require("node:fs") as typeof fs;
      const puvodni = realFs.rmSync;
      realFs.rmSync = ((p: fs.PathLike, o?: fs.RmOptions) => {
        if (String(p).startsWith(sb.tmpRoot)) throw Object.assign(new Error("EBUSY simulované"), { code: "EBUSY" });
        return puvodni(p, o);
      }) as typeof fs.rmSync;
      const docs = [mkDoklad("r4a", { cisloDokladu: "R4-A" }), mkDoklad("r4b", { cisloDokladu: "R4-B" })];
      let rep: ZapisReport;
      try {
        rep = await run(sb, docs);
      } finally {
        realFs.rmSync = puvodni;
      }
      assert.equal(rep.souhrn.pocty.zapsano, 2);
      assert.equal(rep.souhrn.pocty.neprovedeno, 0);
      assert.equal(byMarker(data(sb, "0001"), "r4a").length, 1);
      assert.equal(byMarker(data(sb, "0001"), "r4b").length, 1);
      const rep2 = await run(sb, docs);
      assert.equal(rep2.souhrn.pocty.jiz_zapsano, 2);
    });
  });

  it("runner, který po skutečném importu vyhodí výjimku: doklady v DBF jsou zapsano, ne neprovedeno", async () => {
    await withSandbox(async (sb) => {
      const runner: ImportRunner = async (v) => {
        await defaultRunner(v);
        throw new Error("pád po importu");
      };
      const rep = await run(sb, [mkDoklad("r4c", { cisloDokladu: "R4-C" })], { runner });
      assert.equal(radek(rep, "r4c").stav, "zapsano");
      assert.match(radek(rep, "r4c").kaktusDoklad ?? "", /^FP26\d{4}$/);
      assert.equal(byMarker(data(sb, "0001"), "r4c").length, 1);
    });
  });
});

describe("R5: odložená duplicita ve vstupu", () => {
  const nazev = "Pár Dodavatel s.r.o.";
  const par = (prvni: Record<string, unknown>) => [
    mkDoklad("par_a", { cisloDokladu: "PAR-1", dodavatel: dod({ nazev, ico: "90777001" }), ...prvni }),
    mkDoklad("par_b", { cisloDokladu: "PAR-1", dodavatel: dod({ nazev, ico: "90777001" }) }),
  ];

  it("první DUZP 2025 (E220), druhý 2026 = druhý se zapíše", async () => {
    await withSandbox(async (sb) => {
      const rep = await run(sb, par({ duzp: "2025-12-01", datumVystaveni: "2025-12-01" }));
      assert.equal(radek(rep, "par_a").stav, "chyba_kaktusu");
      assert.equal(radek(rep, "par_a").kod, "E220");
      assert.equal(radek(rep, "par_b").stav, "zapsano");
      const po = data(sb, "0001");
      assert.equal(byMarker(po, "par_a").length, 0);
      assert.equal(byMarker(po, "par_b").length, 1);
    });
  });

  it("první zapsán = druhý odmitnuto s odkazem na FP číslo, v DBF jediný záznam", async () => {
    await withSandbox(async (sb) => {
      const pred = data(sb, "0001");
      const rep = await run(sb, par({}));
      assert.equal(radek(rep, "par_a").stav, "zapsano");
      assert.equal(radek(rep, "par_b").stav, "odmitnuto");
      const fp = radek(rep, "par_a").kaktusDoklad as string;
      assert.ok(fp.startsWith("FP26"));
      assert.ok((radek(rep, "par_b").duvod ?? "").includes(fp));
      const po = data(sb, "0001");
      assert.equal(po.faktury.length, pred.faktury.length + 1);
      assert.equal(byMarker(po, "par_b").length, 0);
    });
  });

  it("první neprovedeno (zámek) = oba neprovedeno, nic v DBF; po odemčení se zapíše jen jeden", async () => {
    await withSandbox(async (sb) => {
      fs.writeFileSync(lockFile(sb, "0001"), "uctarna 1");
      const fak = fakpriBytes(sb, "0001");
      const adr = adresarBytes(sb, "0001");
      const rep = await run(sb, par({}));
      assert.equal(radek(rep, "par_a").stav, "neprovedeno");
      assert.equal(radek(rep, "par_b").stav, "neprovedeno");
      unchanged(sb, "0001", fak, adr);
      fs.rmSync(lockFile(sb, "0001"));
      const rep2 = await run(sb, par({}));
      assert.equal(rep2.souhrn.pocty.zapsano, 1);
      assert.equal(markerCount(sb, "0001"), 1);
    });
  });
});

describe("R6: velikost dávky", () => {
  for (const v of [0, 21, 1.5, -1, NaN]) {
    it(`maxDavka ${String(v)} = VstupniChyba a nic se nezapíše`, async () => {
      await withSandbox(async (sb) => {
        const fak = fakpriBytes(sb, "0001");
        const adr = adresarBytes(sb, "0001");
        await assert.rejects(run(sb, [mkDoklad("v1")], { maxDavka: v }), VstupniChyba);
        unchanged(sb, "0001", fak, adr);
        assert.deepEqual(listDir(sb.tmpRoot), []);
      });
    });
  }
});
