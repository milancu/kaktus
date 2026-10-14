// Formáty a limity polí Kaktusu (ověřeno v kódu simulátoru, ne v příručce).
// Sdílí je validace vstupu z TAXY, příprava hodnot i stavba XML dávky.

/** Částka: nejvýše 8 číslic před tečkou, 1–2 desetinná místa (E130). */
export const AMOUNT_RE = /^-?\d{1,8}(\.\d{1,2})?$/;
/** Částka v tvaru, v jakém ji zapisujeme do XML (vždy dvě desetinná místa). */
export const AMOUNT_OUT_RE = /^-?\d{1,8}\.\d{2}$/;
/** Kurz: nejvýše 4 číslice před a 4 za tečkou (E230). */
export const KURZ_RE = /^\d{1,4}(\.\d{1,4})?$/;
/** IČO: 1–8 číslic (E140); pro porovnání se doplňuje nulami na 8. */
export const ICO_RE = /^\d{1,8}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MENA_RE = /^[A-Z]{3}$/;
export const STAT_RE = /^[A-Za-z]{2}$/;

/** Délky polí v DBF; delší hodnotu by Kaktus potichu ořízl, proto ořezáváme sami. */
export const FIELD_LIMITS = {
  nazev: 40, // ADRESAR.NAZEV
  dic: 14, // ADRESAR.DIC
  ulice: 40,
  mesto: 30,
  psc: 6,
  cisloDodavatele: 20, // FAKPRI.CISLODOD
  variabilniSymbol: 10, // FAKPRI.VS
  text: 50, // FAKPRI.TEXT
  poznamka: 60, // FAKPRI.POZN
} as const;

/** Doplní IČO nulami na 8 číslic (v DBF je číselné, úvodní nuly se ztrácejí). */
export function normalizeIco(ico: string): string {
  return ico.padStart(8, "0");
}

/** Platné datum ve tvaru RRRR-MM-DD (včetně kontroly kalendáře, jako to dělá Kaktus – E120). */
export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
