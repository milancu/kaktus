"use strict";
// Kódování textu v Kaktusu.
//  - DBF soubory jsou v CP852 (LDID 100), ne ve Win-1250 (příručka se mýlí).
//  - XML dávka se čte jako Win-1250 (kodek pro zápis přibude s příkazem `zapis`).
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeCp852 = decodeCp852;
// Horní polovina CP852 (bajty 0x80–0xFF), ověřeno proti simulátoru i tabulce IBM 852.
const CP852_HIGH = "ÇüéâäůćçłëŐőîŹÄĆ" + // 0x80
    "ÉĹĺôöĽľŚśÖÜŤťŁ×č" + // 0x90
    "áíóúĄąŽžĘę¬źČş«»" + // 0xA0
    "░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐" + // 0xB0
    "└┴┬├─┼Ăă╚╔╩╦╠═╬¤" + // 0xC0
    "đĐĎËďŇÍÎě┘┌█▄ŢŮ▀" + // 0xD0
    "ÓßÔŃńňŠšŔÚŕŰýÝţ´" + // 0xE0
    "­˝˛ˇ˘§÷¸°¨˙űŘř■ "; // 0xF0
/** Dekóduje bajty v kódování CP852 na řetězec (každý bajt = jeden znak). */
function decodeCp852(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += b < 0x80 ? String.fromCharCode(b) : CP852_HIGH.charAt(b - 0x80);
    }
    return out;
}
