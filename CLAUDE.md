# Kaktus konektor pro TAXY – instrukce pro agenty

Domácí úkol (zadání v `ZADANI.md`): modul TAXY Connectoru pro fiktivní účetní program
Kaktus. Dvě funkce: (1) čtení dodavatelů a přijatých faktur z DBF, (2) zápis faktur
z TAXY přes XML dávkový import. Poběží bez dozoru u stovek kanceláří → spolehlivost
a bezpečnost mají přednost před funkcemi navíc.

## Časový rozpočet: 3 hodiny celkem

| Blok | Čas | Kdo |
|---|---|---|
| Kostra projektu, CLI, čtení DBF (CP852) + výstup `cist` | 0:30 | implementor |
| Zápis: validace, autorizace, deduplikace, XML, dávky po 20, odpověď, report | 1:00 | implementor |
| Testy jednotkové + integrační nad kopií simulátoru | 0:30 | test-writer |
| Review (správnost + bezpečnost) a opravy | 0:30 | reviewer → implementor |
| README, odpovědi na otázky, výstupy běhu, poznámky o AI | 0:30 | docs-writer + orchestrátor |

Překročí-li blok čas o víc než 15 min, orchestrátor ho zúží a zbytek zapíše do
`docs/PRED-NASAZENIM.md`. Nic se netiše nevypouští.

## Technologie a konvence

- **Cíl: Node 18+.** Zadání uvádí „Node 18+, bez instalace“ a hodnotitel může mít starší Node,
  než je náš vývojový (24). TypeScript se proto kompiluje `tsc` do `dist/` (`npm run build`)
  a spouští `node dist/cli.js` – nespoléhat na nativní spouštění `.ts` (to umí až Node 22.6+).
- Nepoužívat API novější než Node 18 (např. `fs.glob`, `import.meta.dirname`,
  `process.loadEnvFile`, `--experimental-strip-types`). `package.json`: `"engines": {"node": ">=18"}`.
- `dist/` se commituje, aby šlo spustit hned po rozbalení bez `npm install`.
- **Žádné runtime závislosti.** DBF parser, CP852/Win-1250 kodeky a XML escapování píšeme
  sami (je to pár desítek řádků). Dev závislost jen `typescript` (pinned, lockfile).
- Testy: `npm test` = build + vestavěný `node --test` nad zkompilovanými testy. Musí fungovat
  na Node 18 i 24 a na Windows (cmd v npm skriptech nerozbaluje globy – soubory vyjmenovat
  nebo předat adresář tak, aby to fungovalo v obou verzích; ověřit).
- Identifikátory anglicky, doménové pojmy z TAXY/Kaktusu ponechat (`cisloDokladu`, `FAKPRI`).
  Hlášky a výstupy pro uživatele česky.
- Výstupy JSON (UTF-8), zapisované atomicky (tmp soubor + rename).
- Peníze počítat v haléřích jako celá čísla, na string převádět až při serializaci.

## Struktura

```
src/cli.ts            argumenty, příkazy `cist` a `zapis`, exit kódy
src/dbf.ts            čtení dBase III (hlavička, pole, smazané záznamy `*`)
src/codec.ts          CP852 decode, Win-1250 encode, sanitace nereprezentovatelných znaků
src/kaktus/read.ts    FIRMY, ADRESAR, FAKPRI → doménové objekty
src/kaktus/batch.ts   stavba XML dávky (escapování!)
src/kaktus/import.ts  spuštění importu (execFile), parsování odpovědi
src/taxy/input.ts     načtení a striktní validace klienti.json / doklady
src/write.ts          orchestrace zápisu: autorizace → dedup → validace → dávky → reconcile → report
test/                 testy; integrační kopírují celý `kaktus/` do tmp
out/                  výstupy běhu (commitují se – jsou součástí odevzdání)
```

## CLI

```
npm run build
node dist/cli.js cist  --kaktus ./kaktus --out out/kaktus-data.json
node dist/cli.js zapis --kaktus ./kaktus --klienti taxy/klienti.json \
                      --doklady taxy/doklady-k-zapisu.json --out out/zapis-report.json [--dry-run]
```

Exit kódy: 0 = vše zpracováno (i když byly doklady odmítnuty – to je v reportu),
1 = chybný vstup/konfigurace, 2 = nedokončeno (zamčená firma, pád importu) → bezpečné spustit znovu.

Stavy dokladu v reportu: `zapsano`, `jiz_zapsano`, `odmitnuto` (naše validace / autorizace),
`chyba_kaktusu` (kód E… z odpovědi), `neprovedeno` (zámek, pád – zkusit znovu).
Každý doklad může mít `varovani[]` (ořez, transliterace, smazaný doklad se stejným číslem…).

## Kaktus: co platí (ověřeno v kódu simulátoru, příručka se v tom mýlí)

1. DBF jsou v **CP852** (LDID 100), ne Win-1250. XML dávka se čte jako **Win-1250**, bez BOM.
2. Import zpracuje **jen prvních 20 dokladů**, zbytek tiše ignoruje → dávky max 20, ověřit,
   že odpověď má `Doklad` pro každé `poradi`.
3. **Žádná kontrola duplicit** → deduplikujeme my.
4. Exit kódy: 0 zpracováno (i když vše odmítnuto), 1 usage, 2 nečitelná dávka / soubor
   nenalezen (nic nezapsáno), 3 firma zamčená (`FIRMA.LCK`), 4 firma neexistuje.
5. Otevřené období je natvrdo 2026 (E220), číslování `FP26nnnn`. Rok nehardcodujeme u sebe –
   E220 necháme na Kaktusu a namapujeme do reportu.
6. E210 toleruje rozdíl ±1 Kč mezi součtem a `Celkem`.
7. Částky `^-?\d{1,8}(\.\d{1,2})?$`, kurz `^\d{1,4}(\.\d{1,4})?$`, IČO `^\d{1,8}$`.
8. IČO je v DBF **numerické** → úvodní nuly mizí; při čtení doplnit na 8 číslic.
9. Tiché ořezy: název partnera 40, TEXT 50, POZN 60, CISLODOD 20, VS 10. Znaky mimo CP852
   (`→ € „ “ –`) se uloží jako `?`. → Ořez/transliteraci děláme sami a hlásíme jako varování.
10. Parser: samotné `&` nebo neznámá entita = celá dávka odmítnuta (exit 2).
11. Zápis není atomický: záznam po záznamu, partner před fakturou, odpověď až na konci.
    Po pádu může být část zapsaná a odpověď chybí.
12. Partner: hledá se prvním nesmazaným se shodným IČO; bez IČO přesnou shodou názvu
    (ořezaného na 40). Jinak se založí nový.
13. Zámek se kontroluje jen na začátku importu.

Struktura polí: `FIRMY` (ID C4, NAZEV C40, ICO C8, DIC C12, SLOZKA C8, PLATCE L1),
`ADRESAR` (ID N6, NAZEV C40, ICO N8, DIC C14, ULICE C40, MESTO C30, PSC C6, STAT C2, UCET C30, POZN C50),
`FAKPRI` (ID N8, DOKLAD C10, CISLODOD C20, VS C10, PARTNER N6, DATVYST/DATZDAN/DATSPL/DATUHR D8,
ZAKL0/ZAKL12/DPH12/ZAKL21/DPH21/CELKEM N12.2, MENA C3, KURZ N10.4, TEXT C50, POZN C60).

## Data – známé pasti (musí je pokrýt testy)

- Už v Kaktusu: `2026-0931` Čáp (0001), `FV-2609-0188` Perner (0002), `NAJ-2026-09` Háje
  (0001, **jiný VS** → dedup ne podle VS).
- Smazaný `FV26001877` Kuběna (0001, „zadáno na špatnou firmu“) – smazané záznamy nejsou
  duplicita; zapsat s varováním.
- Duplicita uvnitř vstupu: `260914` Kování Říha 2× → zapsat jednou.
- `klientId 5033` neexistuje → odmítnout. `doc_00d80d05f4`: odběratel Pekařství, klient
  Truhlářství → odmítnout (nezapisovat nikam).
- `cisloDokladu: null` → odmítnout. DUZP 2025 → Kaktus vrátí E220.
- Brusivo: součet 2440,57 vs. 2441 → projde (tolerance).
- `Novák & syn`, `<září>` (escapování), `→` (transliterace), název 64 znaků (ořez + varování),
  IČO `00242659`, EUR s kurzem, 3 sazby v jednom dokladu, dodavatel bez DIČ účtující DPH
  (varování), duplicitní partner Pila Ořech (ID 7 a 19).

## Idempotence (klíčové)

- Do `Poznamka` zapisujeme `TAXY:<doc.id>`. Před každým zápisem načteme FAKPRI a doklady
  s tímto ID přeskočíme jako `jiz_zapsano`.
- Záložní shoda pro ručně zadané doklady: nesmazaný záznam se stejným `CISLODOD` a partnerem
  se stejným IČO (bez IČO: název). Přes všechny partnery s daným IČO, ne jen prvního.
- Po každé dávce (i po pádu / chybějící odpovědi) znovu načíst FAKPRI a výsledek ověřit
  podle `TAXY:<id>` – DBF je zdroj pravdy, odpověď je jen nápověda.
- Odpověď vždy do nového souboru v unikátním tmp adresáři (nikdy nečíst starou odpověď).

## Bezpečnost (povinné, reviewer kontroluje)

- **Autorizace (IDOR):** doklad smí do firmy jen tehdy, když `klientId` existuje v
  `klienti.json`, mapuje se na `kaktusFirma`, ta existuje ve `FIRMY.DBF`, a
  `odberatel.ico == klient.ico == FIRMY.ICO`. Firmu nikdy nebrat z obsahu dokladu ani z
  argumentu bez této kontroly. Nesoulad = odmítnout, nehádat.
- **XML injection:** veškerý text jen přes jednu escape funkci (`& < > " '`), odstranit
  znaky neplatné v XML 1.0 (řídicí znaky), názvy elementů jsou konstanty, `firma` musí
  odpovídat `^\d{4}$`. Testovat payloady `</Text><Celkem>1</Celkem>`, `&amp;`, `]]>`, `&#0;`.
- **Parsování odpovědi:** striktní minimální parser, `<!DOCTYPE`/`<!ENTITY` odmítnout
  (XXE, billion laughs), neznámé atributy ignorovat, nesedící `poradi` = chyba.
- **Path traversal:** ID firmy a `SLOZKA` validovat regexem, cestu `path.resolve` a ověřit,
  že leží uvnitř `DATA/`. Dočasné soubory jen přes `fs.mkdtemp`.
- **Command injection:** import jen `execFile`/`spawn` s polem argumentů, `shell: false`,
  timeout; žádné skládání příkazu ze stringu.
- **Vstup z TAXY je nedůvěryhodný:** striktní validace typů, `typ == faktura_prijata`,
  `stav == schvaleno`, konečná čísla, limity délek a velikosti souboru.
- Nikdy nezapisovat přímo do DBF, nikdy neupravovat `kaktus/kaktus.cjs` ani `kaktus/DATA`
  ručně. Do logů ne celé doklady ani bankovní účty.

## Workflow orchestrátora

1. Orchestrátor sám kód nepíše; deleguje na agenty v `.claude/agents/`, kontroluje výsledek
   (spustí testy a CLI) a commituje.
2. Pořadí: implementor (čtení) → commit → implementor (zápis) → commit → test-writer → commit
   → reviewer → implementor opravuje nálezy → commit → docs-writer → commit.
3. Každý delegovaný úkol: konkrétní rozsah, odkaz na sekce tohoto souboru, kritérium hotovo.
4. Malé commity s výstižnou zprávou (historie je součást hodnocení).
5. Rozhodnutí „za TAXY“ zapisovat průběžně do `docs/ROZHODNUTI.md` (podklad pro README).
6. Co se nevejde do časového plánu → `docs/PRED-NASAZENIM.md`.
7. Před finálním během: `node kaktus/kaktus.cjs obnovit`, pak `cist`, `zapis`, znovu `zapis`
   (důkaz idempotence) a výstupy commitnout do `out/`.

## Hotovo znamená

- `cist` i `zapis` běží nad čistými daty (`node kaktus/kaktus.cjs obnovit`) a výstupy jsou v `out/`.
- Druhé spuštění `zapis` nezapíše nic nového (všechno `jiz_zapsano`).
- Zamčená firma → report `neprovedeno`, exit 2, nic nezapsáno; po odemčení doběhne.
- `npm run build` a `npm test` projdou na Node 24 a CLI běží i na Node 18
  (`npx -y node@18 dist/cli.js cist ...`); reviewer nemá otevřené nálezy priority vysoká.
- README ≤ 400 slov, odpovědi na 2 otázky ≤ 5 vět, sekce o práci s AI, čas a částka.
