"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PouzitiChyba = exports.VstupniChyba = void 0;
/**
 * Chyba vstupu nebo konfigurace (chybný argument, poškozený/nečitelný soubor, nebezpečná cesta).
 * CLI ji převede na českou hlášku na stderr a exit kód 1.
 */
class VstupniChyba extends Error {
    constructor(message) {
        super(message);
        this.name = "VstupniChyba";
    }
}
exports.VstupniChyba = VstupniChyba;
/** Chybné použití příkazové řádky (neznámý příkaz či volba, chybějící argument); CLI přidá nápovědu. */
class PouzitiChyba extends VstupniChyba {
    constructor(message) {
        super(message);
        this.name = "PouzitiChyba";
    }
}
exports.PouzitiChyba = PouzitiChyba;
