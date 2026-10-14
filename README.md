# Kaktus konektor pro TAXY

Modul TAXY Connectoru: čtení dodavatelů a přijatých faktur z DBF a zápis faktur z TAXY přes XML dávku. TypeScript, bez runtime závislostí.

## Spuštění

Node 18+. Složka `dist/` je commitnutá, takže jde spustit rovnou; `npm run build` ji přeloží znovu.

```
node dist/cli.js cist  --kaktus ./kaktus --out out/kaktus-data.json
node dist/cli.js zapis --kaktus ./kaktus --klienti taxy/klienti.json \
     --doklady taxy/doklady-k-zapisu.json --out out/zapis-report.json [--dry-run]
npm test
```

Exit kódy: 0 zpracováno (i s odmítnutými doklady), 1 chybný vstup, 2 nedokončeno (zamčená firma, pád importu). Kód 2 je bezpečné spustit znovu.

## Co umí

- Čte DBF přísně (CP852, smazané záznamy, IČO doplněné na 8 číslic).
- Zapisuje po dávkách max. 20 dokladů. Před zápisem ověří autorizaci a deduplikuje.
- Po každé dávce znovu čte FAKPRI. Stav dokladu určuje podle `TAXY:<id>` v poznámce, ne podle odpovědi.
- Report má stavy `zapsano`, `jiz_zapsano`, `odmitnuto`, `chyba_kaktusu`, `neprovedeno` a varování.

Neumí: vydané faktury, dobropisy, vlastní zámek proti souběžnému běhu, zálohu DBF.

## Co jsme zjistili o Kaktusu

Četli jsme kód simulátoru. Příručka se mýlí:
- DBF jsou v CP852, dávka se čte jako Win-1250.
- Import zpracuje jen prvních 20 dokladů, zbytek tiše zahodí.
- Neřeší duplicity.
- Tiše ořezává texty a nereprezentovatelné znaky mění na `?`.
- Zámek kontroluje jen na začátku.
- Zápis není atomický a odpověď vzniká až na konci.
- Samotné `&` v dávce shodí celý import.

## Rozhodnutí za TAXY

Podrobně v [docs/ROZHODNUTI.md](docs/ROZHODNUTI.md). Hlavní:
- Firma se bere jen z `klienti.json`. Nesoulad IČO (doklad, klient, `FIRMY.DBF`) doklad odmítne.
- Smazaný doklad s naší značkou se znovu nezapisuje, rozhodne účetní. Smazaný ruční doklad duplicita není (zapíše se s varováním).
- Ořezy a transliterace děláme sami a hlásíme je jako varování.
- Rok (E220) a součet (E210) kontroluje Kaktus, kód jen mapujeme do reportu.

## Výsledek běhu

Z 37 dokladů: 29 zapsáno, 3 již zapsáno, 4 odmítnuto, 1 chyba E220 (`out/zapis-report.json`). Druhý běh: 0 zapsáno, 32 již zapsáno (`out/zapis-report-2.json`).

## Před nasazením

Úplně v [docs/PRED-NASAZENIM.md](docs/PRED-NASAZENIM.md). Nejdůležitější:
1. Ověřit na skutečném `KAKTUS.EXE`.
2. Zámek proti souběžnému běhu (číslování `FP26nnnn` má race).
3. Záloha DBF a detekce poškození po výpadku proudu.
4. Retry při čtení DBF otevřeného Kaktusem.
5. Hlášení stavu „nedokončeno“ na server TAXY.

## Práce s AI

Viz [docs/AI.md](docs/AI.md). Odpovědi na otázky ze zadání: [docs/ODPOVEDI.md](docs/ODPOVEDI.md).
