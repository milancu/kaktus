// Kódování textu v Kaktusu.
//  - DBF soubory jsou v CP852 (LDID 100), ne ve Win-1250 (příručka se mýlí).
//  - XML dávka se čte jako Win-1250 (kodek pro zápis přibude s příkazem `zapis`).

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
