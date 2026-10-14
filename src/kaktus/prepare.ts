// Převod zvalidovaného dokladu z TAXY na hodnoty polí Kaktusu (čisté funkce bez I/O):
// sanitace znaků, transliterace, ořezy na délky polí DBF, značka `TAXY:<id>` v poznámce
// a varování o všem, co jsme změnili.

import { sanitizeField } from "../codec";
import type { TaxyDoklad } from "../taxy/input";
import type { BatchDoklad } from "./batch";
import { FIELD_LIMITS } from "./format";

/** Prefix značky v poznámce dokladu; podle ní poznáváme, co už jsme zapsali (idempotence). */
export const TAXY_PREFIX = "TAXY:";

/** Značka dokladu v poznámce, např. `TAXY:doc_00a5091cef`. */
export function taxyMarker(docId: string): string {
  return `${TAXY_PREFIX}${docId}`;
}

/**
 * Poznámka dokladu: značka `TAXY:<id>` je na začátku a ořezem se nikdy neztratí – případný
 * další text se ořízne tak, aby se vešel do zbývajícího místa (limit 60 znaků).
 * ID dokladu je omezeno na 40 znaků (viz `DOC_ID_RE`), značka se tedy vždy vejde.
 */
export function composePoznamka(docId: string, extra?: string | null): { text: string; warnings: string[] } {
  const marker = taxyMarker(docId);
  if (marker.length > FIELD_LIMITS.poznamka) {
    throw new Error("ID dokladu je příliš dlouhé pro značku v poznámce.");
  }
  const room = FIELD_LIMITS.poznamka - marker.length - 1;
  if (extra === undefined || extra === null || extra.trim() === "" || room < 1) {
    return { text: marker, warnings: [] };
  }
  const s = sanitizeField(extra, "Poznámka", room);
  return { text: s.text === "" ? marker : `${marker} ${s.text}`, warnings: s.warnings };
}

export type PripravaVysledek =
  | { ok: true; doklad: BatchDoklad; varovani: string[] }
  | { ok: false; duvod: string };

/** Připraví hodnoty polí; prázdné povinné pole (po sanitaci) je důvod k odmítnutí dokladu. */
export function prepareDoklad(d: TaxyDoklad): PripravaVysledek {
  const varovani: string[] = [...d.varovani];
  const take = (value: string | null, label: string, max: number): string => {
    const s = sanitizeField(value ?? "", label, max);
    varovani.push(...s.warnings);
    return s.text;
  };

  const cisloDodavatele = take(d.cisloDokladu, "Číslo dokladu dodavatele", FIELD_LIMITS.cisloDodavatele);
  const nazev = take(d.dodavatel.nazev, "Název dodavatele", FIELD_LIMITS.nazev);
  if (cisloDodavatele === "") return { ok: false, duvod: "Číslo dokladu je po úpravě znaků prázdné." };
  if (nazev === "") return { ok: false, duvod: "Název dodavatele je po úpravě znaků prázdný." };

  const dic = take(d.dodavatel.dic, "DIČ dodavatele", FIELD_LIMITS.dic);
  const poznamka = composePoznamka(d.id);
  varovani.push(...poznamka.warnings);

  if (dic === "" && (d.dph12 !== 0 || d.dph21 !== 0)) {
    varovani.push("Dodavatel nemá DIČ, ale doklad účtuje DPH.");
  }

  const doklad: BatchDoklad = {
    cisloDodavatele,
    variabilniSymbol: take(d.variabilniSymbol, "Variabilní symbol", FIELD_LIMITS.variabilniSymbol),
    dodavatel: {
      nazev,
      ico: d.dodavatel.ico,
      dic,
      ulice: take(d.dodavatel.ulice, "Ulice dodavatele", FIELD_LIMITS.ulice),
      mesto: take(d.dodavatel.mesto, "Město dodavatele", FIELD_LIMITS.mesto),
      psc: take(d.dodavatel.psc, "PSČ dodavatele", FIELD_LIMITS.psc),
      stat: d.dodavatel.stat ?? "",
    },
    datumVystaveni: d.datumVystaveni,
    datumZdanPlneni: d.duzp,
    datumSplatnosti: d.datumSplatnosti,
    zaklad0: d.zaklad0,
    zaklad12: d.zaklad12,
    dph12: d.dph12,
    zaklad21: d.zaklad21,
    dph21: d.dph21,
    celkem: d.celkem,
    mena: d.mena,
    kurz: d.kurz,
    text: take(d.popis, "Text dokladu", FIELD_LIMITS.text),
    poznamka: poznamka.text,
  };
  return { ok: true, doklad, varovani };
}
