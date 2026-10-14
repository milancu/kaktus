# Práce s AI

Instrukce pro agenty jsou v `CLAUDE.md` (role, časový rozpočet, pravidla, bezpečnostní požadavky). Subagenti jsou definovaní v `.claude/agents/`.

## Co dělala AI (z CLAUDE.md a git logu)

- Orchestrátor (Claude Code) kód nepsal. Zadával úkoly subagentům, spouštěl testy a CLI a commitoval.
- Subagenti: `implementor` (čtení, zápis, opravy), `test-writer`, `reviewer`, `docs-writer`.
- Historie má 11 commitů v jednom dni (od 11:45 do 13:12 podle časů commitů):
  1. zadání a instrukce pro agenty,
  2. kostra a `cist`,
  3. plán zápisu,
  4. příkaz `zapis`,
  5. testy,
  6. opravy z review R1–R6,
  7. regresní testy k nálezům,
  8. nízké nálezy z re-review,
  9. výstupy finálního běhu.
- Review našlo 1 vysoký nález a 4 střední (R1–R5) a 1 nízký (R6). Všechny jsou opraveny (commit `57bc470`, regresní testy `54cd0ec`).
- Re-review našlo 3 nízké nálezy. Jsou v `docs/PRED-NASAZENIM.md`.
- Výsledek: 207 testů, výstupy v `out/`, druhý běh `zapis` nezapsal nic nového.
- Do kódu simulátoru jsme se dívali.

## Co jsem ověřoval sám

TODO (uživatel doplní).

## Kde se AI spletla

TODO (uživatel doplní).

## Čas a částka

TODO (uživatel doplní): čas strávený na úkolu a částka k proplacení.
