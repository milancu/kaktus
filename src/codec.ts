// Kódování textu v Kaktusu.
//  - DBF soubory jsou v CP852 (LDID 100), ne ve Win-1250 (příručka se mýlí).
//  - XML dávka se čte jako Win-1250 (kodek pro zápis je níže: `encodeWin1250`).

// Horní polovina CP852 (bajty 0x80–0xFF), ověřeno proti simulátoru i tabulce IBM 852.
const CP852_HIGH: string =
  "ÇüéâäůćçłëŐőîŹÄĆ" + // 0x80
  "ÉĹĺôöĽľŚśÖÜŤťŁ×č" + // 0x90
  "áíóúĄąŽžĘę¬źČş«»" + // 0xA0
  "░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐" + // 0xB0
  "└┴┬├─┼Ăă╚╔╩╦╠═╬¤" + // 0xC0
  "đĐĎËďŇÍÎě┘┌█▄ŢŮ▀" + // 0xD0
  "ÓßÔŃńňŠšŔÚŕŰýÝţ´" + // 0xE0
  "­˝˛ˇ˘§÷¸°¨˙űŘř■ "; // 0xF0

/** Dekóduje bajty v kódování CP852 na řetězec (každý bajt = jeden znak). */
export function decodeCp852(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += b < 0x80 ? String.fromCharCode(b) : CP852_HIGH.charAt(b - 0x80);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zápis: Win-1250 (kódování XML dávky), sanitace a ořezy textů
// ---------------------------------------------------------------------------
//
// Cesta textu je: TAXY (Unicode) → XML dávka (Win-1250) → Kaktus → DBF (CP852).
// Znak se tedy zachová jen tehdy, když existuje v obou kódových stránkách. Cokoli jiného by
// Kaktus potichu změnil na `?`, proto to nahrazujeme sami a hlásíme varování.

// Horní polovina Win-1250 (bajty 0x80–0xFF); � = bajt není ve Win-1250 definován.
const WIN1250_HIGH: string =
  "€�‚�„…†‡�‰Š‹ŚŤŽŹ" + // 0x80
  "�‘’“”•–—�™š›śťžź" + // 0x90
  " ˇ˘Ł¤Ą¦§¨©Ş«¬­®Ż" + // 0xA0
  "°±˛ł´µ¶·¸ąş»Ľ˝ľż" + // 0xB0
  "ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎ" + // 0xC0
  "ĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢß" + // 0xD0
  "ŕáâăäĺćçčéęëěíîď" + // 0xE0
  "đńňóôőö÷řůúűüýţ˙"; // 0xF0

const WIN1250_BYTE: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < WIN1250_HIGH.length; i++) {
    const ch = WIN1250_HIGH.charAt(i);
    if (ch !== "�") m.set(ch, 0x80 + i);
  }
  return m;
})();

/** Znaky >= 0x80, které přežijí celou cestu (existují ve Win-1250 i v CP852). */
const SAFE_NON_ASCII: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const ch of WIN1250_BYTE.keys()) if (CP852_HIGH.includes(ch)) s.add(ch);
  return s;
})();

/**
 * Zakóduje text do Win-1250 (bez BOM). Znak, který ve Win-1250 neexistuje, se zapíše jako `?`
 * (stejně jako to dělá Kaktus); běžná cesta sem takový znak nepustí, protože texty prošly
 * `sanitizeField`.
 */
export function encodeWin1250(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) bytes.push(cp);
    else bytes.push(WIN1250_BYTE.get(ch) ?? 0x3f);
  }
  return Buffer.from(bytes);
}

/** Je znak povolený v XML 1.0 (`Char`)? Zbylé řídicí znaky, nepárové surrogáty, U+FFFE/U+FFFF ne. */
export function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

// Rozumné ASCII náhrady znaků, které Kaktus neumí uložit.
const TRANSLITERATION: ReadonlyMap<string, string> = new Map<string, string>([
  ["→", "->"], ["←", "<-"], ["↔", "<->"], ["⇒", "=>"],
  ["€", "EUR"],
  ["„", '"'], ["“", '"'], ["”", '"'], ["‟", '"'], ["″", '"'],
  ["‚", "'"], ["‘", "'"], ["’", "'"], ["‛", "'"], ["′", "'"],
  ["–", "-"], ["—", "-"], ["‐", "-"], ["‑", "-"], ["‒", "-"], ["−", "-"],
  ["…", "..."], ["•", "*"], ["·", "."],
  ["™", "TM"], ["©", "(c)"], ["®", "(R)"],
  ["±", "+/-"], ["µ", "u"], ["¦", "|"], ["¶", " "],
  ["¼", "1/4"], ["½", "1/2"], ["¾", "3/4"],
  ["≤", "<="], ["≥", ">="], ["≠", "!="],
  ["ø", "o"], ["Ø", "O"], ["æ", "ae"], ["Æ", "AE"], ["œ", "oe"], ["Œ", "OE"],
]);

function transliterate(ch: string): string | null {
  const direct = TRANSLITERATION.get(ch);
  if (direct !== undefined) return direct;
  // Písmeno s diakritikou mimo naše kódování (ñ, ǎ, …) → základní písmeno.
  const stripped = ch.normalize("NFD").replace(/\p{M}/gu, "");
  return stripped !== "" && /^[\x20-\x7e]+$/.test(stripped) ? stripped : null;
}

export interface SanitizedField {
  text: string;
  /** České hlášky o všem, co jsme změnili (transliterace, ořez, odstraněné znaky). */
  warnings: string[];
}

/**
 * Připraví text do pole Kaktusu o nejvýše `maxLen` znacích:
 *  - Unicode NFC; tabulátor a konce řádků → mezera; ostatní řídicí a formátovací znaky pryč
 *    (neplatné v XML 1.0, v DBF nemají co dělat);
 *  - znaky mimo Win-1250 ∩ CP852 → transliterace (`→` → `->`, `€` → `EUR`, …), jinak `?`;
 *  - ořez mezer na krajích (Kaktus je stejně ořezává) a ořez na `maxLen` znaků.
 * Každou změnu popíše ve `warnings` s názvem pole `label`.
 */
export function sanitizeField(value: string, label: string, maxLen: number): SanitizedField {
  const warnings: string[] = [];
  let out = "";
  let removed = 0;
  let unknown = 0;
  const replaced = new Map<string, string>();
  for (const ch of value.normalize("NFC")) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x9 || cp === 0xa || cp === 0xd) {
      out += " ";
    } else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) || /^\p{Cf}$/u.test(ch)) {
      removed++;
    } else if (cp < 0x80 || SAFE_NON_ASCII.has(ch)) {
      out += ch;
    } else if (/^\p{Zs}$/u.test(ch)) {
      out += " ";
    } else {
      const rep = transliterate(ch);
      if (rep === null) {
        out += "?";
        unknown++;
      } else {
        out += rep;
        replaced.set(ch, rep);
      }
    }
  }
  if (removed > 0) warnings.push(`${label}: odstraněny řídicí a neviditelné znaky (počet: ${removed}).`);
  if (replaced.size > 0) {
    const list = [...replaced].map(([from, to]) => `„${from}“ za „${to}“`).join(", ");
    warnings.push(`${label}: znaky, které Kaktus neumí uložit, nahrazeny (${list}).`);
  }
  if (unknown > 0) {
    warnings.push(`${label}: znaky, které Kaktus neumí uložit, nahrazeny znakem ? (počet: ${unknown}).`);
  }
  let text = out.trim();
  if (text.length > maxLen) {
    warnings.push(`${label}: ořezáno z ${text.length} na ${maxLen} znaků.`);
    text = text.slice(0, maxLen).trimEnd();
  }
  return { text, warnings };
}
