# Rozhodnutí „za TAXY“ a technická rozhodnutí

Průběžně doplňováno; podklad pro README.

## Čtení (`cist`)

- **Smazané záznamy se ve výstupu `cist` ponechávají** s příznakem `smazano: true`
  (transparentnost; zápis s nimi pracuje zvlášť – smazaný doklad není duplicita).
  Smazaná firma ve `FIRMY.DBF` je ve výstupu také, ale s `dodavatele: null` a `faktury: null`
  (data se nečtou, firma se nikdy nesmí autorizovat).
- Výstup má pro každou firmu dodavatele (ADRESAR) a přijaté faktury (FAKPRI); faktura odkazuje
  na dodavatele přes `partnerId` (= `ADRESAR.ID`). Výstup neobsahuje časové razítko, aby byl
  při stejných datech bajtově shodný (porovnání běhů, čisté commity do `out/`).
- Částky ve výstupu jsou v haléřích (celá čísla), převod z textu DBF probíhá řetězcově bez
  floatu. Data jsou ISO `RRRR-MM-DD`. IČO je řetězec o 8 číslicích (doplněné úvodní nuly).
- **Přísné čtení DBF:** jiná verze než dBase III (0x03), jiný LDID než 100 (CP852), nesedící
  délka záznamu, useknutý soubor nebo neplatný příznak záznamu = chyba vstupu (exit 1), ne
  hádání. Soubor větší než 256 MiB se nečte.
- **`SLOZKA` musí být rovna ID firmy.** Import Kaktusu hledá složku podle ID (`firma="…"`),
  takže při jiné `SLOZKA` bychom četli (a deduplikovali) jinde, než kam se zapisuje. Raději
  odmítnout než hádat. Cesta se navíc ověří přes `path.resolve` a `realpath`, že leží uvnitř `DATA/`.
- Chyba v jedné firmě ukončí celé `cist` s exit 1 a názvem firmy v hlášce (částečný výstup
  by mohl být zaměněn za úplný).

## Technologie

- **Dev závislost `@types/node@18.19.130` navíc k `typescript`.** Bez typů Node nelze
  `fs`/`path`/`node:test` v TypeScriptu přeložit. Verze 18 je záměrná: typová kontrola pak
  chytí použití API novějších než Node 18. Do runtime nic nepřibývá.
- `typescript` je pinned na 5.9.3 (ne 7.x – ta řada má jiný překladač/CLI; pro stabilitu build chain).
- Testy se kompilují zvlášť (`tsconfig.test.json` → `build-test/`, v `.gitignore`), aby `dist/`
  obsahoval jen produkční kód. Testy tak importují `../src/...` a běží nad kompilací v `build-test/src/`.
  `npm test` = build + build:test + `scripts/run-tests.js` (hledá `*.test.js` sám, protože cmd
  na Windows nerozbaluje globy).
- Atomický zápis JSON: dočasný soubor v adresáři vytvořeném `fs.mkdtemp` ve složce cíle,
  `fsync`, `rename`; adresář se vždy uklidí.

## Zápis: vstup, autorizace, deduplikace (plánovací část)

- **Chyba souboru vs. chyba dokladu.** Nevalidní JSON, soubor větší než limit (klienti 1 MiB,
  doklady 10 MiB, max. 5 000 dokladů), špatná struktura nebo vadný záznam v `klienti.json`
  = `VstupniChyba` (exit 1). Vadný jednotlivý doklad = `odmitnuto` s českým důvodem, ostatní
  se zpracují. V `klienti.json` je chybou i dvakrát stejné `klientId` a **dvakrát stejná
  `kaktusFirma`** (jeden klient = jedna firma; jinak by autorizace nebyla jednoznačná).
- **Autorizace (IDOR)** je první krok po načtení identity dokladu (`id`, `klientId`, IČO
  odběratele) a před jakoukoli další prací: `klientId` je v `klienti.json` právě jednou →
  `kaktusFirma` (`^\d{4}$`) → firma je ve `FIRMY.DBF` a není smazaná → IČO odběratele z dokladu
  == IČO klienta == `FIRMY.ICO`. Firma se bere jen z `klienti.json`, nikdy z dokladu (pole
  `firma`/`kaktusFirma` v dokladu se ignorují). IČO se porovnávají po doplnění nulami na 8 číslic.
  Firma, jejíž data nejsou v mapě předané `planWrite`, se považuje za neexistující.
- **Přísné typy.** `klientId` musí být číslo (ne řetězec), částky a kurz čísla (ne řetězce), `mena`
  třípísmenná velkými písmeny, `stat` dvě písmena. Částka se převádí z nejkratšího zápisu čísla
  přes regex Kaktusu (max. 8 číslic, 2 desetinná místa), nic se nezaokrouhluje; `1.234` se odmítne.
- **Rozpis DPH.** Povolené sazby jsou 0, 12, 21 (pole Kaktusu `ZAKL0`, `ZAKL12/DPH12`,
  `ZAKL21/DPH21`), každá nejvýše jednou, 1–3 položky; u sazby 0 musí být daň nulová (jinak by se
  ztratila). Jiná sazba = doklad odmítnout, nehádat. Kontrolu `Celkem` (E210, tolerance ±1 Kč)
  a rok DUZP (E220) neduplikujeme – necháváme na Kaktusu a mapujeme jeho kód do reportu.
- **Kurz u CZK** se ignoruje (do XML se neposílá) s varováním; u cizí měny je povinný a kladný.
- **ID dokladu** musí odpovídat `^[A-Za-z0-9_-]{1,40}$` (končí v poznámce `TAXY:<id>` o max. 60
  znacích, ořezem se tak neztratí). Opakované `id` ve vstupu = další výskyt `odmitnuto`.
- **Značka v poznámce.** `POZN` = `TAXY:<id>`. Při dedup se porovnává celé ID (token), takže
  `TAXY:doc_1` není shoda pro `doc_12`. Případný další text poznámky by se ořezával tak, aby
  značka zůstala celá (`composePoznamka`); TAXY zatím žádný takový text neposílá.
- **Sanitace textů.** Do Kaktusu se uloží jen znaky, které existují ve Win-1250 **i** v CP852
  (cesta XML → DBF). Ostatní: transliterace (`→`→`->`, `€`→`EUR`, `„“”`→`"`, `‘’`→`'`, `–—`→`-`,
  `…`→`...`, `™`→`TM`, písmena s diakritikou mimo kódování → základní písmeno), jinak `?`.
  Tabulátor a konce řádků → mezera, ostatní řídicí a formátovací znaky se odstraní. Texty se
  normalizují do NFC, ořezávají o mezery (Kaktus je stejně ořezává) a pak na limit pole.
  Každý zásah je `varovani[]` s názvem pole. Ořezy: název partnera 40, DIČ 14, ulice 40, město 30,
  PSČ 6, `CISLODOD` 20, VS 10, `TEXT` 50, `POZN` 60 (tato pole simulátor ořízne potichu).
- **Prázdné po sanitaci.** Číslo dokladu nebo název dodavatele, které po odstranění znaků zůstanou
  prázdné, = doklad `odmitnuto`.
- **Dedup – záložní shoda** používá číslo dokladu ve stejné podobě, v jaké ho zapisujeme
  (sanitované, ořezané na 20), a dodavatele podle IČO (přes všechny partnery se stejným IČO),
  bez IČO podle názvu ořezaného na 40. VS se nepoužívá. Důsledek ořezu: dva různé doklady stejného
  dodavatele, jejichž čísla se liší až za 20. znakem, se při záložní shodě považují za jeden
  (druhý by skončil jako `jiz_zapsano`); je to vzácné a doklad dostane varování o ořezu.
- **Dedup – partner smazaný v adresáři.** Pro určení dodavatele existujícího dokladu se použije
  i partner s příznakem smazání (nesmazaný doklad zůstává platným dokladem, i když někdo smazal
  jeho partnera; opačný postup by vedl k duplicitnímu zápisu). Smazané *doklady* se naopak
  ignorují a vedou jen k varování.
- **Smazaný doklad se stejným číslem** (i smazaný doklad s naší značkou `TAXY:<id>`) není
  duplicita: doklad se zapíše s varováním a číslem smazaného dokladu.
- **Duplicita uvnitř vstupu** (stejná firma + dodavatel + číslo dokladu, jiné `id`): první se
  zapíše, další je `odmitnuto` s důvodem „Duplicita ve vstupu…“. Zvolen `odmitnuto`, ne
  `jiz_zapsano`: doklad nebyl nikam zapsán, a při dalším běhu zůstane výsledek stejný (první už
  bude `jiz_zapsano` přes značku, druhý stále duplicita). Porovnává se po sanitaci a ořezu, jako
  v Kaktusu. Pořadí kontrol: značka `TAXY:<id>` → duplicita ve vstupu → záložní shoda podle čísla.
- **Dávka.** Win-1250 bez BOM s deklarací `encoding="windows-1250"` (simulátor deklaraci
  nečte, dávku dekóduje vždy jako Win-1250), hodnoty přes jedinou funkci `escapeXml`
  (`& < > " '` + zahození znaků neplatných v XML 1.0), názvy elementů jsou konstanty, `firma`
  `^\d{4}$`, max. 20 dokladů. Nepřidáváme atribut `poradi` do dokladů: pořadí je dané pozicí
  (simulátor ho v odpovědi číslem od 1 odvozuje z pozice). Volitelné prvky bez hodnoty se
  vynechají (`Stat` prázdný → Kaktus doplní `CZ`).
- **Varování „dodavatel bez DIČ účtuje DPH“** vzniká při prázdném DIČ a nenulové DPH 12 % nebo 21 %.
