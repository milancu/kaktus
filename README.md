# Kaktus konektor pro TAXY

Modul TAXY Connectoru: čte dodavatele a přijaté faktury z DBF Kaktusu a zapisuje faktury z TAXY přes XML dávku. TypeScript, bez dalších knihoven.

## Spuštění

Node 18+. Přeložený kód v `dist/` je v repozitáři, instalace není potřeba.

```
node dist/cli.js cist  --kaktus ./kaktus --out out/kaktus-data.json
node dist/cli.js zapis --kaktus ./kaktus --klienti taxy/klienti.json \
     --doklady taxy/doklady-k-zapisu.json --out out/zapis-report.json [--dry-run]
npm test
```

Exit kódy: 0 zpracováno (i s odmítnutými doklady), 1 chybný vstup, 2 nedokončeno (firma otevřená u účetní, pád importu). Po kódu 2 stačí příkaz zopakovat, nic se nezapíše dvakrát.

## Co umí

- Čte DBF v CP852 včetně smazaných záznamů. Když soubor nemá očekávaný formát, skončí chybou.
- Ověří, že doklad patří dané firmě a že v Kaktusu ještě není.
- Zapisuje po dávkách nejvýš 20 dokladů se značkou `TAXY:<id>` v poznámce. Podle ní pak v DBF ověří, co se opravdu zapsalo.
- Report uvádí u dokladů stav, důvod a varování.

Neumí vydané faktury ani dobropisy.

## Co jsem zjistil o Kaktusu

Minifikovaný kód simulátoru jsem prošel s pomocí AI. Od příručky se liší:
- DBF jsou v CP852, ne ve Windows-1250; dávku čte jako Windows-1250.
- Zpracuje jen prvních 20 dokladů, o ostatních v odpovědi nic není.
- Duplicity nekontroluje.
- Dlouhé texty bez upozornění ořízne a neznámé znaky (`→`) uloží jako `?`.
- IČO ukládá jako číslo, takže ztrácí úvodní nuly.
- Odpověď vzniká až na konci, po pádu může být zapsaná jen část dávky.
- Samotný znak `&` shodí celou dávku.

## Rozhodnutí za TAXY

Podrobně v [docs/ROZHODNUTI.md](docs/ROZHODNUTI.md). Hlavní:
- Firmu určuje jen `klienti.json`. Když nesedí IČO na dokladu, u klienta a ve `FIRMY.DBF`, doklad se odmítne.
- Náš doklad, který účetní smazala, se znovu nezapisuje. Smazaný ruční doklad duplicita není.
- Ořezy a náhrady znaků (`→` na `->`) dělá konektor sám a hlásí je jako varování.
- Otevřený rok (E220) a součet částek (E210) hlídá Kaktus, jeho kód jde do reportu.

## Výsledek běhu

Z 37 dokladů: 29 zapsáno, 3 již zapsáno, 4 odmítnuto, 1 chyba E220 (`out/zapis-report.json`). Druhý běh: 0 zapsáno, 32 již zapsáno (`out/zapis-report-2.json`).

## Před nasazením

Úplně v [docs/PRED-NASAZENIM.md](docs/PRED-NASAZENIM.md). Nejdůležitější:
1. Ověřit na skutečném `KAKTUS.EXE`.
2. Zabránit dvěma konektorům nad stejnou firmou zároveň: přidělily by si stejné číslo dokladu.
3. Zálohovat DBF před importem.
4. Hlásit „nedokončeno“ na server TAXY.

## Práce s AI

Viz [docs/AI.md](docs/AI.md). Odpovědi na otázky ze zadání: [docs/ODPOVEDI.md](docs/ODPOVEDI.md).
