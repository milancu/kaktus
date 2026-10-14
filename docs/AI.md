# Práce s AI

Instrukce pro agenty jsou v `CLAUDE.md` (kontext, zjištění o Kaktusu, časový rozpočet, pravidla,
bezpečnostní požadavky), subagenti v `.claude/agents/` (implementor, test-writer, reviewer,
docs-writer – každý s vlastními pravidly, modelem a effortem).

## Jak to probíhalo

- **Rozbor (session 1, Claude Code):** AI prošla zadání, data a minifikovaný kód simulátoru
  a sepsala, kde se Kaktus chová jinak než příručka (CP852, limit 20 dokladů, žádná kontrola
  duplicit, exit kódy 0–4, ořezy polí…). Z toho vznikl `CLAUDE.md` a definice agentů.
- **Implementace (session 2, orchestrátor):** spuštěná přes `/goal` s měřitelnými kritérii
  (testy, očekávané stavy konkrétních dokladů, idempotentní druhý běh, čistý `git status`).
  Orchestrátor kód nepsal, delegoval na subagenty a po každém kroku commitoval (viz `git log`).
- **Review:** reviewer našel 1 vysoký, 4 střední a 1 nízký nález (R1–R6), všechny opravené
  (`57bc470`) s regresními testy (`54cd0ec`); nízké nálezy z re-review jsou v
  `docs/PRED-NASAZENIM.md`.
- **Nezávislé ověření a úprava (session 1):** AI zopakovala běh na kopii dat (zamčená firma →
  `neprovedeno` a doběhnutí po odemčení, žádné duplicity v DBF, uložení speciálních znaků)
  a přímo v této session změnila formát částek ve výstupu čtení (`4ecfb0b`).

## Co jsem ověřoval sám

- Kód simulátoru je minifikovaný; prošla ho AI, já jsem z rozboru pochopil, co zhruba dělá,
  a jednotlivá zjištění jsem si nechal vysvětlit.
- S pomocí AI jsem si udělal artifact, na kterém jsem si ověřil své předpoklady, jak řešení
  funguje teď a jak má fungovat.
- Výsledek orchestrátora jsem nechal nezávisle přezkoušet v první session, mimo orchestrátora
  (testy, celý běh zápisu, zamčená firma, duplicity).
- Bezpečnostní ochrany (IDOR, XML injection, XXE, path traversal, command injection) jsem si prošel
  a vyzkoušel na ukázkovém skriptu.

## Kde se AI spletla

- Plán původně stavěl na Node 24 a nativním spouštění `.ts`; na to, že zadání uvádí Node 18+,
  jsem upozornil já. Opraveno kompilací do `dist/` (`da0e9e0`).
- Hned v první odpovědi si AI vyložila můj dotaz tak, že si TAXY pletu s daněmi :DD.
- Výstup čtení měl částky v haléřích jako čísla bez označení jednotky (EUR faktura 2360.00
  vypadala jako 236000); odhaleno až při kontrole výstupu, opraveno (`4ecfb0b`).
- Deduplikace v první verzi selhala, když IČO chybělo jen na jedné straně, a testy to
  nezachytily – našel to až reviewer (R1).

## Čas a částka

- Čas: necelé 3 hodiny.
- Částka k proplacení: 2 000 Kč.
