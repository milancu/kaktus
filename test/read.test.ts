// Scénář 1: čtení DBF – CP852, IČO s nulami, smazané záznamy, částky v haléřích, duplicitní partner.
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDbf } from "../src/dbf";
import { VstupniChyba } from "../src/errors";
import { mapDodavatele, mapFaktury, mapFirmy, parseCents, icoFromNumber, readAll } from "../src/kaktus/read";
import { main } from "../src/cli";
import { makeSandbox, hashTree, ORIG_KAKTUS } from "./helpers";
import type { Sandbox } from "./helpers";

// --- pomocník: sestaví DBF (dBase III, LDID 100, CP852) v paměti -------------------------------

const CP852_BYTES: Record<string, number> = {
  "Č": 0xac, "č": 0x9f, "Ř": 0xfc, "ř": 0xfd, "Ž": 0xa6, "ž": 0xa7, "Š": 0xe6, "š": 0xe7, "Á": 0xb5, "á": 0xa0,
  "É": 0x90, "é": 0x82, "Í": 0xd6, "í": 0xa1, "Ó": 0xe0, "ó": 0xa2, "Ú": 0xe9, "ú": 0xa3, "ů": 0x85, "Ů": 0xde,
  "Ě": 0xb7, "ě": 0xd8, "Ď": 0xd2, "ď": 0xd4, "Ť": 0x9b, "ť": 0x9c, "Ň": 0xd5, "ň": 0xe5, "Ý": 0xed, "ý": 0xec,
};

function cp852(text: string): number[] {
  return [...text].map((ch) => {
    if (ch.charCodeAt(0) < 128) return ch.charCodeAt(0);
    const b = CP852_BYTES[ch];
    if (b === undefined) throw new Error(`test: znak ${ch} není v tabulce`);
    return b;
  });
}

interface F { name: string; type: string; len: number; dec?: number }

function buildDbf(fields: F[], rows: { deleted?: boolean; values: string[] }[], opts: { ldid?: number; version?: number } = {}): Buffer {
  const headerLen = 32 + fields.length * 32 + 1;
  const recLen = 1 + fields.reduce((a, f) => a + f.len, 0);
  const head = Buffer.alloc(headerLen, 0);
  head[0] = opts.version ?? 3;
  head[1] = 126; head[2] = 1; head[3] = 1;
  head.writeUInt32LE(rows.length, 4);
  head.writeUInt16LE(headerLen, 8);
  head.writeUInt16LE(recLen, 10);
  head[29] = opts.ldid ?? 100;
  fields.forEach((f, i) => {
    const p = 32 + i * 32;
    head.write(f.name, p, "ascii");
    head[p + 11] = f.type.charCodeAt(0);
    head[p + 16] = f.len;
    head[p + 17] = f.dec ?? 0;
  });
  head[headerLen - 1] = 0x0d;
  const parts: Buffer[] = [head];
  for (const r of rows) {
    const rec = Buffer.alloc(recLen, 0x20);
    rec[0] = r.deleted === true ? 0x2a : 0x20;
    let pos = 1;
    fields.forEach((f, i) => {
      const bytes = Buffer.from(cp852(r.values[i] ?? ""));
      if (f.type === "N") bytes.copy(rec, pos + f.len - bytes.length);
      else bytes.copy(rec, pos);
      pos += f.len;
    });
    parts.push(rec);
  }
  parts.push(Buffer.from([0x1a]));
  return Buffer.concat(parts);
}

const ADRESAR: F[] = [
  { name: "ID", type: "N", len: 6 }, { name: "NAZEV", type: "C", len: 40 }, { name: "ICO", type: "N", len: 8 },
  { name: "DIC", type: "C", len: 14 }, { name: "ULICE", type: "C", len: 40 }, { name: "MESTO", type: "C", len: 30 },
  { name: "PSC", type: "C", len: 6 }, { name: "STAT", type: "C", len: 2 }, { name: "UCET", type: "C", len: 30 },
  { name: "POZN", type: "C", len: 50 },
];

describe("DBF parser (syntetická data)", () => {
  it("dekóduje CP852 diakritiku, doplní IČO nulami a označí smazané záznamy", () => {
    const buf = buildDbf(ADRESAR, [
      { values: ["1", "ŽELEZÁŘSTVÍ ČÁP s.r.o.", "242659", "", "Příbram", "Říčany", "26101", "CZ", "", ""] },
      { deleted: true, values: ["2", "Smazaný Ďábel", "", "", "", "", "", "CZ", "", ""] },
    ]);
    const list = mapDodavatele(parseDbf(buf, "t"), "t");
    assert.equal(list.length, 2);
    assert.equal(list[0]?.nazev, "ŽELEZÁŘSTVÍ ČÁP s.r.o.");
    assert.equal(list[0]?.ico, "00242659", "úvodní nuly se musí doplnit na 8 číslic");
    assert.equal(list[0]?.smazano, false);
    assert.equal(list[0]?.mesto, "Říčany");
    assert.equal(list[1]?.smazano, true);
    assert.equal(list[1]?.ico, null);
  });

  it("odmítne jiné kódování (LDID), jinou verzi, useknutý soubor a neplatný příznak záznamu", () => {
    const rows = [{ values: ["1", "A", "1", "", "", "", "", "CZ", "", ""] }];
    assert.throws(() => parseDbf(buildDbf(ADRESAR, rows, { ldid: 0xc8 }), "t"), VstupniChyba);
    assert.throws(() => parseDbf(buildDbf(ADRESAR, rows, { version: 0x83 }), "t"), VstupniChyba);
    const ok = buildDbf(ADRESAR, rows);
    assert.throws(() => parseDbf(ok.subarray(0, ok.length - 40), "t"), VstupniChyba);
    const bad = Buffer.from(ok);
    bad[32 + ADRESAR.length * 32 + 1] = 0x41;
    assert.throws(() => parseDbf(bad, "t"), VstupniChyba);
    assert.throws(() => parseDbf(Buffer.alloc(10), "t"), VstupniChyba);
  });

  it("částky se převádějí na haléře bez float chyb", () => {
    assert.equal(parseCents("2440.57", "t"), 244057);
    assert.equal(parseCents("-12", "t"), -1200);
    assert.equal(parseCents("0.1", "t"), 10);
    assert.equal(parseCents("19999999.99", "t"), 1999999999);
    assert.throws(() => parseCents("1,5", "t"), VstupniChyba);
    assert.equal(icoFromNumber(242659, "t"), "00242659");
    assert.throws(() => icoFromNumber(123456789, "t"), VstupniChyba);
  });

  it("mapFaktury a mapFirmy: nesprávná struktura = chyba vstupu", () => {
    const wrong = buildDbf([{ name: "ID", type: "N", len: 4 }], [{ values: ["1"] }]);
    assert.throws(() => mapFaktury(parseDbf(wrong, "t"), "t"), VstupniChyba);
    assert.throws(() => mapFirmy(parseDbf(wrong, "t"), "t"), VstupniChyba);
  });
});

describe("Čtení reálných dat Kaktusu (kopie)", () => {
  let sb: Sandbox;
  let origBefore: string;
  before(() => {
    origBefore = hashTree(ORIG_KAKTUS);
    sb = makeSandbox();
  });
  after(() => {
    sb.cleanup();
    assert.equal(hashTree(ORIG_KAKTUS), origBefore, "originální složka kaktus/ se nesmí změnit");
  });

  it("firmy: IČO a složky", () => {
    const v = readAll(sb.kaktusDir);
    assert.deepEqual(v.firmy.map((f) => [f.id, f.ico, f.slozka, f.smazano]), [
      ["0001", "90412761", "0001", false],
      ["0002", "90581130", "0002", false],
    ]);
    assert.equal(v.firmy[0]?.dodavatele?.length, 24);
    assert.equal(v.firmy[0]?.faktury?.length, 46);
    assert.equal(v.firmy[1]?.dodavatele?.length, 9);
    assert.equal(v.firmy[1]?.faktury?.length, 14);
  });

  it("CP852 diakritika: Čáp, Ořech, Kuběna, Háje", () => {
    const d = readAll(sb.kaktusDir).firmy[0]?.dodavatele ?? [];
    const by = (id: number) => d.find((x) => x.id === id);
    assert.equal(by(2)?.nazev, "ŽELEZÁŘSTVÍ ČÁP s.r.o.");
    assert.equal(by(7)?.nazev, "Pila Ořech s.r.o.");
    assert.equal(by(7)?.mesto, "Rožmitál pod Třemšínem");
    assert.equal(by(8)?.nazev, "Nářadí Kuběna s.r.o.");
    assert.equal(by(15)?.nazev, "Obec Háje");
    assert.equal(by(15)?.ulice, "Háje 39");
    for (const x of d) assert.ok(!x.nazev.includes("�") && !x.nazev.includes("?"), `špatný název ${x.nazev}`);
  });

  it("IČO s úvodními nulami (00242659) a dodavatel bez IČO/DIČ", () => {
    const d = readAll(sb.kaktusDir).firmy[0]?.dodavatele ?? [];
    assert.equal(d.find((x) => x.id === 15)?.ico, "00242659");
    assert.equal(d.find((x) => x.id === 15)?.dic, null);
    for (const x of d) assert.ok(x.ico === null || /^\d{8}$/.test(x.ico), `IČO ${x.ico} musí mít 8 číslic`);
  });

  it("smazané záznamy mají smazano: true (doklady 20 a 39, partner 20)", () => {
    const f = readAll(sb.kaktusDir).firmy[0];
    const fak = f?.faktury ?? [];
    assert.deepEqual(fak.filter((x) => x.smazano).map((x) => [x.id, x.doklad, x.cisloDodavatele]), [
      [20, "FP260020", "2026900117"],
      [39, "FP260039", "FV26001877"],
    ]);
    assert.deepEqual((f?.dodavatele ?? []).filter((x) => x.smazano).map((x) => x.id), [20]);
  });

  it("částky v haléřích jako celá čísla, data ISO", () => {
    const fak = readAll(sb.kaktusDir).firmy[0]?.faktury ?? [];
    const c = fak.find((x) => x.doklad === "FP260045");
    assert.ok(c);
    assert.equal(c.zaklad21, 326446);
    assert.equal(c.dph21, 68554);
    assert.equal(c.celkem, 395000);
    assert.equal(c.partnerId, 2);
    assert.equal(c.datumVystaveni, "2026-09-22");
    assert.equal(c.mena, "CZK");
    for (const x of fak) {
      for (const v of [x.zaklad0, x.zaklad12, x.dph12, x.zaklad21, x.dph21, x.celkem]) {
        assert.ok(v === null || Number.isInteger(v), `částka ${v} není celé číslo`);
      }
    }
  });

  it("duplicitní partner Pila Ořech: ID 7 a 19 se stejným IČO, oba přečteny", () => {
    const d = readAll(sb.kaktusDir).firmy[0]?.dodavatele ?? [];
    const pila = d.filter((x) => x.ico === "90100077");
    assert.deepEqual(pila.map((x) => x.id), [7, 19]);
    assert.notEqual(pila[0]?.nazev, pila[1]?.nazev);
    assert.equal(pila[1]?.nazev, "PILA OŘECH SRO");
  });

  it("cist: výstup je deterministický (bajtově shodný, bez časového razítka)", async () => {
    const o1 = path.join(sb.root, "cist1.json");
    const o2 = path.join(sb.root, "cist2.json");
    const io = { out: () => {}, err: () => {} };
    assert.equal(await main(["cist", "--kaktus", sb.kaktusDir, "--out", o1], io), 0);
    assert.equal(await main(["cist", "--kaktus", sb.kaktusDir, "--out", o2], io), 0);
    assert.ok(fs.readFileSync(o1).equals(fs.readFileSync(o2)));
    const parsed = JSON.parse(fs.readFileSync(o1, "utf8")) as { format: number; firmy: { id: string }[] };
    assert.equal(parsed.format, 1);
    assert.equal(parsed.firmy.length, 2);
    assert.deepEqual(fs.readdirSync(sb.root).filter((n) => n.includes("tmp") && n !== "tmp"), []);
  });
});

describe("Čtení: path traversal a podvržená SLOZKA (upravená kopie FIRMY.DBF)", () => {
  /** Přepíše SLOZKA druhé firmy v kopii FIRMY.DBF (FIRMY: flag+ID4+NAZEV40+ICO8+DIC12+SLOZKA8). */
  function patchSlozka(sb: Sandbox, value: string): void {
    const file = path.join(sb.kaktusDir, "DATA", "FIRMY.DBF");
    const buf = fs.readFileSync(file);
    const headerLen = buf.readUInt16LE(8);
    const recLen = buf.readUInt16LE(10);
    const off = headerLen + recLen + 1 + 4 + 40 + 8 + 12;
    buf.fill(0x20, off, off + 8);
    buf.write(value, off, "ascii");
    fs.writeFileSync(file, buf);
  }

  for (const [value, popis] of [["../0001", "traversal přes .."], ["0001", "SLOZKA jiná než ID"], ["..", "samotné .."]] as const) {
    it(`${popis} (${value}) = chyba vstupu, exit 1`, async () => {
      const sb = makeSandbox();
      try {
        patchSlozka(sb, value);
        assert.throws(() => readAll(sb.kaktusDir), VstupniChyba);
        const out = path.join(sb.root, "o.json");
        const err: string[] = [];
        assert.equal(await main(["cist", "--kaktus", sb.kaktusDir, "--out", out], { out: () => {}, err: (t) => err.push(t) }), 1);
        assert.ok(!fs.existsSync(out), "při chybě nesmí vzniknout částečný výstup");
        assert.ok(err.join("\n").includes("0002"), "hláška má jmenovat firmu");
      } finally {
        sb.cleanup();
      }
    });
  }
});
