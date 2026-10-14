// Scénáře 7 a 8 (jednotkově): escapování XML, stavba dávky (Win-1250 bez BOM, názvy elementů),
// sanitace textů a kodeky.
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildBatches, buildBatchXml, escapeXml, formatCents, MAX_BATCH_SIZE } from "../src/kaktus/batch";
import type { BatchDoklad } from "../src/kaktus/batch";
import { decodeCp852, decodeWin1250, encodeWin1250, isXmlChar, sanitizeField } from "../src/codec";
import { composePoznamka, prepareDoklad } from "../src/kaktus/prepare";
import { parseDoklad } from "../src/taxy/input";
import { mkDoklad } from "./helpers";

function mkBatch(over: Partial<BatchDoklad> = {}): BatchDoklad {
  return {
    cisloDodavatele: "C1",
    variabilniSymbol: "1",
    dodavatel: { nazev: "Firma", ico: "12345678", dic: "CZ12345678", ulice: "U", mesto: "M", psc: "11000", stat: "CZ" },
    datumVystaveni: "2026-10-01",
    datumZdanPlneni: "2026-10-01",
    datumSplatnosti: null,
    zaklad0: 0, zaklad12: 0, dph12: 0, zaklad21: 10000, dph21: 2100, celkem: 12100,
    mena: "CZK", kurz: null, text: "Text", poznamka: "TAXY:x",
    ...over,
  };
}

const ALLOWED = new Set([
  "KaktusDavka", "FakturaPrijata", "CisloDodavatele", "VarSymbol", "Dodavatel", "Nazev", "ICO", "DIC", "Ulice",
  "Mesto", "PSC", "Stat", "DatumVystaveni", "DatumZdanPlneni", "DatumSplatnosti", "Zaklad0", "Zaklad12", "DPH12",
  "Zaklad21", "DPH21", "Celkem", "Mena", "Kurz", "Text", "Poznamka",
]);

/** Názvy všech značek v dokumentu (hodnoty jsou escapované, takže každé `<` je skutečná značka). */
function tagNames(xml: string): string[] {
  const out: string[] = [];
  const re = /<(\/?)([A-Za-z0-9_]+)([^<>]*)>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) if (m[1] === "") out.push(m[2] as string);
  return out;
}

describe("escapeXml", () => {
  it("escapuje & < > \" ' a nic jiného", () => {
    assert.equal(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    assert.equal(escapeXml("Příliš žluťoučký kůň"), "Příliš žluťoučký kůň");
    assert.equal(escapeXml(""), "");
  });

  it("payloady: injekce elementu, předescapované entity, CDATA konec, číselné odkazy", () => {
    assert.equal(escapeXml("</Text><Celkem>1</Celkem>"), "&lt;/Text&gt;&lt;Celkem&gt;1&lt;/Celkem&gt;");
    assert.equal(escapeXml("&amp;"), "&amp;amp;");
    assert.equal(escapeXml("]]>"), "]]&gt;");
    assert.equal(escapeXml("&#0;"), "&amp;#0;");
    assert.equal(escapeXml("&#x41;&lt;"), "&amp;#x41;&amp;lt;");
    assert.equal(escapeXml("Novák & syn"), "Novák &amp; syn");
    assert.equal(escapeXml("<září>"), "&lt;září&gt;");
  });

  it("zahazuje znaky neplatné v XML 1.0 (řídicí, nepárové surrogáty, U+FFFE), tabulátor a LF nechává", () => {
    assert.equal(escapeXml("a\u0000b\u0001c\u0008d\u000be\u000cf\u001fg"), "abcdefg");
    assert.equal(escapeXml("x\ud800y"), "xy");
    assert.equal(escapeXml("x￾y￿"), "xy");
    assert.equal(escapeXml("a\tb\nc"), "a\tb\nc");
    assert.equal(escapeXml("😀"), "😀");
    for (const cp of [0, 1, 8, 0xb, 0xc, 0xe, 0x1f, 0xd800, 0xfffe, 0xffff, 0x110000]) assert.equal(isXmlChar(cp), false, String(cp));
    for (const cp of [9, 10, 13, 0x20, 0xd7ff, 0xe000, 0xfffd, 0x10000, 0x10ffff]) assert.equal(isXmlChar(cp), true, String(cp));
  });
});

describe("buildBatchXml", () => {
  it("Win-1250 bez BOM, deklarace windows-1250, firma jako atribut, česká diakritika správnými bajty", () => {
    const buf = buildBatchXml("0001", [mkBatch({ text: "Žluťoučký kůň", dodavatel: { ...mkBatch().dodavatel, nazev: "Čáp Říha" } })]);
    assert.ok(buf.subarray(0, 5).toString("latin1") === "<?xml", "první bajty = <?xml, žádný BOM");
    assert.notEqual(buf[0], 0xef);
    assert.notEqual(buf[0], 0xff);
    const latin = buf.toString("latin1");
    assert.ok(latin.startsWith('<?xml version="1.0" encoding="windows-1250"?>\n<KaktusDavka verze="3.2" firma="0001">'));
    // Č = 0xC8, á = 0xE1, Ř = 0xD8, ů = 0xF9, ť = 0x9D
    assert.ok(buf.includes(Buffer.from([0xc8, 0xe1, 0x70, 0x20, 0xd8])), "Čáp Ř v bajtech Win-1250");
    assert.ok(buf.includes(Buffer.from([0xf9])));
    assert.equal(decodeWin1250(buf).includes("Žluťoučký kůň"), true);
    // UTF-8 podoba by obsahovala bajt 0xC3/0xC4/0xC5 následovaný 0x80–0xBF pro diakritiku; Win-1250 ne
    assert.ok(!buf.includes(Buffer.from("Č", "utf8")));
  });

  it("injekční payloady v hodnotách nevytvoří žádný nový element ani druhý Celkem", () => {
    const evil = "</Text><Celkem>1</Celkem>";
    const buf = buildBatchXml("0001", [
      mkBatch({ text: evil, poznamka: "]]> &#0; &amp;", cisloDodavatele: "<x>", variabilniSymbol: "&",
        dodavatel: { nazev: "</Nazev><ICO>1</ICO>", ico: "12345678", dic: "'\"", ulice: "<!-- -->", mesto: "<![CDATA[", psc: "<", stat: "CZ" } }),
    ]);
    const xml = decodeWin1250(buf);
    const names = tagNames(xml);
    for (const n of names) assert.ok(ALLOWED.has(n), `neočekávaný element ${n}`);
    assert.equal(names.filter((n) => n === "Celkem").length, 1);
    assert.equal(names.filter((n) => n === "Text").length, 1);
    assert.equal(names.filter((n) => n === "Nazev").length, 1);
    assert.equal(names.filter((n) => n === "ICO").length, 1);
    assert.ok(xml.includes("<Text>&lt;/Text&gt;&lt;Celkem&gt;1&lt;/Celkem&gt;</Text>"));
    assert.ok(xml.includes("<Poznamka>]]&gt; &amp;#0; &amp;amp;</Poznamka>"));
    assert.ok(xml.includes("<Celkem>121.00</Celkem>"));
    assert.ok(!xml.includes("<![CDATA["));
    assert.ok(!xml.includes("<!--"));
    // žádný syrový řídicí znak ve výstupu
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml));
  });

  it("firma musí odpovídat ^\\d{4}$ – jinak se dávka vůbec nesestaví", () => {
    for (const bad of ["../0002", "001", "00001", "abcd", '0001"><x', "0001\n", ""]) {
      assert.throws(() => buildBatchXml(bad, [mkBatch()]), JSON.stringify(bad));
    }
  });

  it("nejvýše 20 dokladů v dávce, prázdná dávka je chyba", () => {
    assert.equal(MAX_BATCH_SIZE, 20);
    assert.doesNotThrow(() => buildBatchXml("0001", Array.from({ length: 20 }, () => mkBatch())));
    assert.throws(() => buildBatchXml("0001", Array.from({ length: 21 }, () => mkBatch())));
    assert.throws(() => buildBatchXml("0001", []));
  });

  it("buildBatches dělí po maximálně 20 (45 -> 20,20,5) a drží pořadí", () => {
    const items = Array.from({ length: 45 }, (_, i) => ({ i, doklad: mkBatch({ cisloDodavatele: `N${i}` }) }));
    const davky = buildBatches("0001", items);
    assert.deepEqual(davky.map((d) => d.polozky.length), [20, 20, 5]);
    assert.deepEqual(davky.flatMap((d) => d.polozky.map((p) => p.i)), items.map((x) => x.i));
    assert.throws(() => buildBatches("0001", items, 21));
    assert.throws(() => buildBatches("0001", items, 0));
    assert.deepEqual(buildBatches("0001", items, 7).map((d) => d.polozky.length), [7, 7, 7, 7, 7, 7, 3]);
  });

  it("formát vstupů: neplatné datum, IČO, měna a kurz se do XML nedostanou", () => {
    assert.throws(() => buildBatchXml("0001", [mkBatch({ datumVystaveni: "2026-10-01<" })]));
    assert.throws(() => buildBatchXml("0001", [mkBatch({ dodavatel: { ...mkBatch().dodavatel, ico: "123456789" } })]));
    assert.throws(() => buildBatchXml("0001", [mkBatch({ mena: "EUR", kurz: "1e3" })]));
    assert.throws(() => buildBatchXml("0001", [mkBatch({ mena: "eur" })]));
    assert.throws(() => buildBatchXml("0001", [mkBatch({ celkem: 1.5 })]));
  });

  it("formatCents: haléře na text bez float chyb, záporné částky, hranice", () => {
    assert.equal(formatCents(244057), "2440.57");
    assert.equal(formatCents(5), "0.05");
    assert.equal(formatCents(0), "0.00");
    assert.equal(formatCents(-1234), "-12.34");
    assert.equal(formatCents(-5), "-0.05");
    assert.equal(formatCents(999999999), "9999999.99");
    assert.equal(formatCents(1999999999), "19999999.99");
    assert.equal(formatCents(9999999999), "99999999.99");
    assert.throws(() => formatCents(10000000000), "9 číslic před desetinnou čárkou je mimo formát");
    assert.throws(() => formatCents(1.5));
    assert.throws(() => formatCents(NaN));
  });
});

describe("kodeky", () => {
  it("CP852: české znaky podle tabulky (Č=0xAC, ř=0xFD, ů=0x85, Ž=0xA6)", () => {
    assert.equal(decodeCp852(Uint8Array.from([0xac, 0xfd, 0x85, 0xa6, 0xd8, 0x41])), "ČřůŽěA");
  });

  it("Win-1250 round-trip všech českých písmen; nepodporovaný znak = ?", () => {
    const t = "ÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž";
    const bytes = encodeWin1250(t);
    assert.equal(bytes.length, t.length);
    assert.equal(decodeWin1250(bytes), t);
    assert.equal(bytes[0], 0xc1);
    assert.equal(encodeWin1250("→").toString("latin1"), "?");
    assert.equal(encodeWin1250("😀").toString("latin1"), "?");
    assert.equal(encodeWin1250("€")[0], 0x80, "€ je ve Win-1250, ale ne v CP852");
  });
});

describe("sanitizeField", () => {
  it("transliterace € „ “ – → … včetně varování se jménem pole", () => {
    const r = sanitizeField("5 € „x“ – y → z …", "Text", 50);
    assert.equal(r.text, '5 EUR "x" - y -> z ...');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0] as string, /^Text: /);
  });

  it("neznámé znaky -> ? a varování; diakritika mimo kódování -> základní písmeno", () => {
    const r = sanitizeField("Señor 中 😀 ǎ", "Město", 50);
    assert.equal(r.text, "Senor ? ? a");
    assert.ok(r.warnings.some((w) => /znakem \? \(počet: 2\)/.test(w)));
  });

  it("české znaky zůstanou beze změny a bez varování", () => {
    const r = sanitizeField("ŽLUŤOUČKÝ kůň", "X", 50);
    assert.equal(r.text, "ŽLUŤOUČKÝ kůň");
    assert.deepEqual(r.warnings, []);
  });

  it("řídicí znaky se odstraní (varování), tab/LF/CR -> mezera, ořez mezer", () => {
    const r = sanitizeField("  a\u0000b\u0007c\td\ne\r\nf​g  ", "X", 50);
    assert.equal(r.text, "abc d e  fg");
    assert.ok(r.warnings.some((w) => /odstraněny řídicí/.test(w)));
  });

  it("ořez na limit s varováním a bez koncové mezery; neořezává při přesném limitu", () => {
    const r = sanitizeField("a".repeat(39) + " " + "b".repeat(30), "Název", 40);
    assert.equal(r.text, "a".repeat(39));
    assert.match(r.warnings.join(""), /ořezáno z 70 na 40/);
    assert.deepEqual(sanitizeField("x".repeat(40), "N", 40).warnings, []);
    assert.equal(sanitizeField("x".repeat(40), "N", 40).text.length, 40);
  });

  it("ořez nerozdělí surrogátový pár uprostřed (emoji se nahradí ? před ořezem)", () => {
    const r = sanitizeField("a😀".repeat(30), "X", 40);
    assert.ok(!/[\ud800-\udfff]/.test(r.text));
    assert.ok(r.text.length <= 40);
  });

  it("NFD vstup (znak + kombinující akcent) se sjednotí na NFC", () => {
    const r = sanitizeField("Ca" + String.fromCharCode(0x301) + "p R" + String.fromCharCode(0x30c) + "iha", "X", 50);
    assert.equal(r.text, "C" + String.fromCharCode(0xe1) + "p " + String.fromCharCode(0x158) + "iha");
    assert.deepEqual(r.warnings, []);
  });
});

describe("prepareDoklad a poznámka", () => {
  it("poznámka = TAXY:<id>, id nejdelší (40 znaků) se vejde do 60 a neořízne", () => {
    const id = "x".repeat(40);
    assert.equal(composePoznamka(id).text, `TAXY:${id}`);
    assert.equal(composePoznamka(id).text.length, 45);
    const s = composePoznamka("abc", "z".repeat(100)).text;
    assert.ok(s.startsWith("TAXY:abc "));
    assert.ok(s.length <= 60);
    assert.throws(() => composePoznamka("y".repeat(60)));
  });

  it("doklad s názvem a číslem jen z neplatných znaků je po sanitaci odmítnut", () => {
    const p = parseDoklad(mkDoklad("p1", { cisloDokladu: "\u0001\u0002" }));
    assert.ok(p.ok);
    const prep = prepareDoklad(p.doklad);
    assert.equal(prep.ok, false);
  });

  it("DPH bez DIČ -> varování; CZK s kurzem -> kurz ignorován s varováním", () => {
    const d = mkDoklad("p2", { kurz: 25 });
    (d.dodavatel as Record<string, unknown>).dic = null;
    const p = parseDoklad(d);
    assert.ok(p.ok);
    const prep = prepareDoklad(p.doklad);
    assert.ok(prep.ok);
    assert.ok(prep.varovani.some((v) => /nemá DIČ/.test(v)));
    assert.ok(prep.varovani.some((v) => /Kurz/.test(v)));
    assert.equal(prep.doklad.kurz, null);
  });
});
