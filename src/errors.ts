/**
 * Chyba vstupu nebo konfigurace (chybný argument, poškozený/nečitelný soubor, nebezpečná cesta).
 * CLI ji převede na českou hlášku na stderr a exit kód 1.
 */
export class VstupniChyba extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VstupniChyba";
  }
}

/** Chybné použití příkazové řádky (neznámý příkaz či volba, chybějící argument); CLI přidá nápovědu. */
export class PouzitiChyba extends VstupniChyba {
  constructor(message: string) {
    super(message);
    this.name = "PouzitiChyba";
  }
}
