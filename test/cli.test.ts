// Scénář 11: CLI – exit kódy 0/1, argumenty, chybějící soubory, nevalidní JSON, atomický výstup.
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { main, parseArgs, shrnuti } from "../src/cli";
import { VstupniChyba } from "../src/errors";
import type { ZapisReport } from "../src/write";
import { makeSandbox, mkDoklad, ROOT, fakpriBytes, data, byMarker } from "./helpers";
import type { Sandbox } from "./helpers";

function capture() {
  const lines: string[] = [];
  return { io: { out: (t: string) => lines.push(t), err: (t: string) => lines.push(t) }, lines };
}

async function withSandbox(fn: (sb: Sandbox) => Promise<void>): Promise<void> {
  const sb = makeSandbox();
  try {
    await fn(sb);
  } finally {
    sb.cleanup();
  }
}

function zapisArgs(sb: Sandbox, over: Record<string, string> = {}, flags: string[] = []): string[] {
  const o: Record<string, string> = {
    kaktus: sb.kaktusDir,
    klienti: path.join(sb.root, "klienti.json"),
    doklady: path.join(sb.root, "doklady.json"),
    out: path.join(sb.root, "out", "report.json"),
    ...over,
  };
  return ["zapis", ...Object.entries(o).flatMap(([k, v]) => [`--${k}`, v]), ...flags];
}

function seed(sb: Sandbox, doklady: unknown = [mkDoklad("c1")]): void {
  fs.copyFileSync(path.join(ROOT, "taxy", "klienti.json"), path.join(sb.root, "klienti.json"));
  fs.writeFileSync(path.join(sb.root, "doklady.json"), JSON.stringify(doklady));
  fs.mkdirSync(path.join(sb.root, "out"), { recursive: true });
}

describe("parseArgs", () => {
  it("odmítne chybějící příkaz, neznámý příkaz, neznámou volbu, duplicity, chybějící hodnoty a povinné volby", () => {
    const bad: string[][] = [
      [], ["neco"], ["cist"], ["cist", "--kaktus", "k"], ["cist", "--kaktus", "k", "--out", "o", "--dry-run"],
      ["cist", "--kaktus", "k", "--kaktus", "k2", "--out", "o"], ["cist", "--kaktus", "--out", "o"],
      ["cist", "--kaktus", "", "--out", "o"], ["cist", "kaktus", "k", "--out", "o"],
      ["zapis", "--kaktus", "k", "--klienti", "a", "--doklady", "b"],
      ["zapis", "--kaktus", "k", "--klienti", "a", "--doklady", "b", "--out", "o", "--dry-run", "--dry-run"],
      ["zapis", "--kaktus", "k", "--klienti", "a", "--doklady", "b", "--out", "o", "--firma", "0002"],
      ["constructor"], ["__proto__"], ["toString"],
    ];
    for (const a of bad) assert.throws(() => parseArgs(a), VstupniChyba, JSON.stringify(a));
  });

  it("platné argumenty", () => {
    const a = parseArgs(["zapis", "--kaktus", "k", "--klienti", "a", "--doklady", "b", "--out", "o", "--dry-run"]);
    assert.equal(a.command, "zapis");
    assert.ok(a.flags.has("dry-run"));
    assert.equal(a.options.get("out"), "o");
  });
});

describe("main – exit kódy", () => {
  it("--help = 0; bez argumentů / neznámý příkaz = 1 s nápovědou na stderr", async () => {
    const c = capture();
    assert.equal(await main(["--help"], c.io), 0);
    assert.ok(c.lines.join("\n").includes("Použití"));
    const d = capture();
    assert.equal(await main([], d.io), 1);
    assert.equal(await main(["smaz"], d.io), 1);
  });

  it("cist: neexistující složka Kaktusu = 1 a žádný výstup", async () => {
    await withSandbox(async (sb) => {
      const out = path.join(sb.root, "o.json");
      assert.equal(await main(["cist", "--kaktus", path.join(sb.root, "neni"), "--out", out], capture().io), 1);
      assert.ok(!fs.existsSync(out));
      assert.equal(await main(["cist", "--kaktus", path.join(sb.root, "klienti-neni.json"), "--out", out], capture().io), 1);
    });
  });

  it("cist: složka bez DATA/FIRMY.DBF = 1", async () => {
    await withSandbox(async (sb) => {
      const prazdna = path.join(sb.root, "prazdna");
      fs.mkdirSync(prazdna);
      assert.equal(await main(["cist", "--kaktus", prazdna, "--out", path.join(sb.root, "o.json")], capture().io), 1);
    });
  });

  it("zapis: chybějící klienti.json / doklady / složka = 1, nic nezapsáno, report nevznikne", async () => {
    await withSandbox(async (sb) => {
      seed(sb);
      const fak = fakpriBytes(sb, "0001");
      const out = path.join(sb.root, "out", "report.json");
      const variants: Record<string, string>[] = [
        { klienti: path.join(sb.root, "neni.json") },
        { doklady: path.join(sb.root, "neni.json") },
        { kaktus: path.join(sb.root, "neni") },
      ];
      for (const over of variants) {
        const c = capture();
        assert.equal(await main(zapisArgs(sb, over), c.io), 1, JSON.stringify(over));
        assert.ok(c.lines.length > 0, "uživatel dostane českou hlášku");
      }
      assert.ok(!fs.existsSync(out));
      assert.ok(fakpriBytes(sb, "0001").equals(fak));
    });
  });

  it("zapis: nevalidní JSON v klienti i v dokladech = 1", async () => {
    await withSandbox(async (sb) => {
      seed(sb);
      fs.writeFileSync(path.join(sb.root, "klienti.json"), "{ rozbite");
      assert.equal(await main(zapisArgs(sb), capture().io), 1);
      seed(sb);
      fs.writeFileSync(path.join(sb.root, "doklady.json"), "[1, 2,");
      assert.equal(await main(zapisArgs(sb), capture().io), 1);
      fs.writeFileSync(path.join(sb.root, "doklady.json"), '{"neni": "pole"}');
      assert.equal(await main(zapisArgs(sb), capture().io), 1);
      fs.writeFileSync(path.join(sb.root, "doklady.json"), Buffer.from([0x5b, 0xe8, 0x5d]));
      assert.equal(await main(zapisArgs(sb), capture().io), 1, "Win-1250 místo UTF-8");
      assert.ok(!fs.existsSync(path.join(sb.root, "out", "report.json")));
      assert.equal(data(sb, "0001").faktury.filter((f) => f.poznamka.startsWith("TAXY:")).length, 0);
    });
  });

  it("zapis: poškozená data firmy (useknutý FAKPRI.DBF) = 1 před jakýmkoli zápisem", async () => {
    await withSandbox(async (sb) => {
      seed(sb);
      const f = path.join(sb.kaktusDir, "DATA", "0001", "FAKPRI.DBF");
      const buf = fs.readFileSync(f);
      fs.writeFileSync(f, buf.subarray(0, buf.length - 100));
      const adr = fs.readFileSync(path.join(sb.kaktusDir, "DATA", "0001", "ADRESAR.DBF"));
      const c = capture();
      assert.equal(await main(zapisArgs(sb), c.io), 1);
      assert.ok(c.lines.join("\n").includes("0001"));
      assert.ok(fs.readFileSync(path.join(sb.kaktusDir, "DATA", "0001", "ADRESAR.DBF")).equals(adr));
    });
  });

  it("zapis: chybí kaktus.cjs = 1 (před zápisem), ale --dry-run ho nevyžaduje", async () => {
    await withSandbox(async (sb) => {
      seed(sb);
      fs.rmSync(path.join(sb.kaktusDir, "kaktus.cjs"));
      assert.equal(await main(zapisArgs(sb), capture().io), 1);
      assert.ok(!fs.existsSync(path.join(sb.root, "out", "report.json")));
      assert.equal(await main(zapisArgs(sb, {}, ["--dry-run"]), capture().io), 0);
    });
  });

  it("zapis: úspěch = 0, report atomicky zapsaný (bez tmp zbytků), druhý běh též 0 a nic nepřidá", async () => {
    await withSandbox(async (sb) => {
      seed(sb, [mkDoklad("c1"), mkDoklad("c2", { klientId: 5033 }), mkDoklad("c3", { mena: "EUR", kurz: 24.5, cisloDokladu: "EUR-1" })]);
      const c = capture();
      assert.equal(await main(zapisArgs(sb), c.io), 0, "odmítnutý doklad nesmí změnit exit kód");
      const out = path.join(sb.root, "out", "report.json");
      const rep = JSON.parse(fs.readFileSync(out, "utf8")) as ZapisReport;
      assert.deepEqual(rep.doklady.map((d) => d.stav), ["zapsano", "odmitnuto", "zapsano"]);
      assert.deepEqual(fs.readdirSync(path.dirname(out)), ["report.json"], "žádné tmp soubory vedle reportu");
      assert.ok(c.lines.join("\n").includes("Zpracováno 3 dokladů"));
      assert.equal(byMarker(data(sb, "0001"), "c3").length, 1);
      const fak = fakpriBytes(sb, "0001");
      assert.equal(await main(zapisArgs(sb), capture().io), 0);
      assert.ok(fakpriBytes(sb, "0001").equals(fak));
      const rep2 = JSON.parse(fs.readFileSync(out, "utf8")) as ZapisReport;
      assert.deepEqual(rep2.doklady.map((d) => d.stav), ["jiz_zapsano", "odmitnuto", "jiz_zapsano"]);
    });
  });

  it("výstupy neobsahují celé doklady ani bankovní účty (jen id, stavy, hlášky)", async () => {
    await withSandbox(async (sb) => {
      seed(sb, [mkDoklad("c1", { cisloUctu: "123456789/0100", ucet: "CZ6508000000192000145399" })]);
      const c = capture();
      assert.equal(await main(zapisArgs(sb), c.io), 0);
      const text = fs.readFileSync(path.join(sb.root, "out", "report.json"), "utf8") + c.lines.join("\n");
      assert.ok(!text.includes("123456789/0100"));
      assert.ok(!text.includes("CZ6508000000192000145399"));
      assert.ok(!text.includes('"rozpisDph"'));
      assert.ok(!text.includes('"dodavatel"'));
    });
  });

  it("zapis: když nejsou žádné doklady (prázdné pole), exit 0 a prázdný report", async () => {
    await withSandbox(async (sb) => {
      seed(sb, []);
      assert.equal(await main(zapisArgs(sb), capture().io), 0);
      const rep = JSON.parse(fs.readFileSync(path.join(sb.root, "out", "report.json"), "utf8")) as ZapisReport;
      assert.equal(rep.souhrn.celkem, 0);
    });
  });
});

describe("shrnuti", () => {
  it("zmiňuje přerušené firmy a bezpečné opakování při neprovedeno", () => {
    const pocty = { zapsano: 1, jiz_zapsano: 0, odmitnuto: 0, chyba_kaktusu: 0, neprovedeno: 2, k_zapisu: 0 };
    const rep: ZapisReport = {
      format: 1, rezim: "zapis", doklady: [],
      souhrn: { celkem: 3, pocty, firmy: { "0001": { pocty, preruseno: "Firma 0001 je zamčena" } } },
    };
    const s = shrnuti(rep).join("\n");
    assert.match(s, /Firma 0001 přerušena: Firma 0001 je zamčena/);
    assert.match(s, /bezpečně zopakovat/);
    assert.match(s, /neprovedeno 2/);
  });
});
