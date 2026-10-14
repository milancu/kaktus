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
  (sanitované, ořezané na 20), a dodavatele. Dodavatel se porovnává takto (shoda je symetrická):
  když mají IČO obě strany (doklad z TAXY i partner v Kaktusu), musí se shodovat IČO – přes
  všechny partnery se stejným IČO; když IČO chybí alespoň na jedné straně, musí se shodovat
  název (NFC, sloučené mezery, ořez na 40 znaků, bez rozlišení velikosti písmen). Doklad z TAXY
  bez IČO se tedy hledá podle názvu přes všechny partnery (i ty s IČO), doklad s IČO podle IČO
  a navíc podle názvu mezi partnery bez IČO (např. Holz Bauer GmbH, ID 16). Dřívější varianta
  „s IČO jen podle IČO, bez IČO jen podle názvu mezi partnery bez IČO“ nenašla ručně zadaný doklad,
  když IČO chybělo jen na jedné straně, a doklad se zapsal podruhé (a založil se nový partner).
  Stejné pravidlo platí pro duplicity uvnitř vstupu. VS se nepoužívá. Důsledek ořezu: dva různé
  doklady stejného dodavatele, jejichž čísla se liší až za 20. znakem, se při záložní shodě
  považují za jeden (druhý by skončil jako `jiz_zapsano`); je to vzácné a doklad dostane
  varování o ořezu. Důsledek porovnání podle názvu: dva různé subjekty se stejným názvem a stejným
  číslem dokladu, z nichž jeden nemá IČO, se považují za jednoho dodavatele (zvolená bezpečnější
  chyba: raději nezapsat než zapsat podruhé).
- **Dedup – partner smazaný v adresáři.** Pro určení dodavatele existujícího dokladu se použije
  i partner s příznakem smazání (nesmazaný doklad zůstává platným dokladem, i když někdo smazal
  jeho partnera; opačný postup by vedl k duplicitnímu zápisu). Smazané *doklady* se naopak
  ignorují jako duplicitu (viz „Smazaný doklad“ níže).
- **Smazaný doklad.** Dva případy se záměrně liší:
  - *Smazaný záznam s naší značkou `TAXY:<id>`* znamená „doručeno a účetní v Kaktusu smazala“.
    Doklad se **nezapisuje znovu**: stav `odmitnuto` s důvodem „Doklad byl už zapsán (FPxxxx)
    a v Kaktusu smazán – znovu ho nezapisujeme, rozhodne účetní.“ (zvolena bezpečnější varianta;
    opětovný zápis by oživil doklad, který někdo úmyslně smazal, při každém běhu by se to opakovalo).
    Pokud existuje nesmazaný záznam se stejnou značkou, má přednost (`jiz_zapsano`). Další výskyt
    téhož dodavatele a čísla ve vstupu se pak odmítne jako duplicita (bez pokusu o zápis).
  - *Smazaný ruční záznam bez značky* (např. Kuběna `FV26001877`) duplicita není: doklad se zapíše
    s varováním a číslem smazaného dokladu.
- **Duplicita uvnitř vstupu** (stejná firma + dodavatel + číslo dokladu, jiné `id`; pravidlo shody
  dodavatele viz výše): první výskyt se zkusí zapsat, další výskyt se **odloží**, dokud není známý
  výsledek prvního (ověřený podle DBF), a teprve pak se rozhodne:
  - první je `zapsano`/`jiz_zapsano` → další zůstává `odmitnuto` (duplicita) s odkazem na
    skutečně zapsaný doklad („…jako doklad doc_X, který je v Kaktusu jako FP26nnnn“);
  - první skončil `chyba_kaktusu` nebo `odmitnuto` (např. E220 u DUZP 2025) → další výskyt se
    přeplánuje proti čerstvým datům a zkusí se zapsat (je to typicky opravený doklad); případné
    další výskyty se pak odkládají na něj;
  - první je `neprovedeno` (zámek, pád, nebo byla přerušena firma) → další výskyt je také
    `neprovedeno` (nikdy se nezapisují oba); při dalším běhu se rozhodne znovu.
  Výjimka: je-li první výskyt konečně odmítnutý kvůli smazanému záznamu s naší značkou (viz výše),
  další výskyt se neodkládá, ale rovnou odmítne. `planWrite` (čistá funkce) vrací duplicitu jako
  `odmitnuto` s příznakem `odlozitNa` (ID prvního dokladu); rozhodnutí podle výsledku zápisu dělá
  `write.ts`. V `--dry-run` se nic nezapisuje, takže duplicita zůstává `odmitnuto`. Opakované
  `id` ve vstupu je odmítnuto vždy hned. Pořadí kontrol: značka `TAXY:<id>` → smazaná značka →
  duplicita ve vstupu → záložní shoda podle čísla.
- **Dávka.** Win-1250 bez BOM s deklarací `encoding="windows-1250"` (simulátor deklaraci
  nečte, dávku dekóduje vždy jako Win-1250), hodnoty přes jedinou funkci `escapeXml`
  (`& < > " '` + zahození znaků neplatných v XML 1.0), názvy elementů jsou konstanty, `firma`
  `^\d{4}$`, max. 20 dokladů. Nepřidáváme atribut `poradi` do dokladů: pořadí je dané pozicí
  (simulátor ho v odpovědi číslem od 1 odvozuje z pozice). Volitelné prvky bez hodnoty se
  vynechají (`Stat` prázdný → Kaktus doplní `CZ`).
- **Varování „dodavatel bez DIČ účtuje DPH“** vzniká při prázdném DIČ a nenulové DPH 12 % nebo 21 %.

## Zápis: import, ověření podle DBF, report

- **Import** běží přes `execFile(process.execPath, [kaktus.cjs, "import", dávka, odpověď])`: pole
  argumentů, `shell: false`, `windowsHide`, timeout 60 s. `kaktus.cjs` se hledá ve složce zadané
  `--kaktus`; chybí-li, je to chyba vstupu (exit 1) ještě před jakýmkoli zápisem. Spouštěč je
  vyměnitelný (`ZapisOpts.runner`), výjimka z něj se bere jako pád importu.
- **Dočasné soubory:** každá dávka má nový `fs.mkdtemp(<tmp>/taxy-kaktus-)`; dávka i odpověď jsou
  v něm. Odpověď se nikdy nečte odjinud. Adresář se maže v `finally` jako **best-effort**
  (`maxRetries`, chyba úklidu např. EBUSY/EPERM se ignoruje): úklid nesmí přebít výsledek
  doběhlého importu. Při selhání úklidu zůstane v tmp adresář s dávkou (jen XML s doklady,
  práva 0600). Stejně se chová úklid po úspěšném `rename` v `writeFileAtomic`.
- **Exit kódy importu:** 0 zpracováno, 2 dávka nečitelná (nic nezapsáno), 3 firma zamčená, 4 firma
  neexistuje, vše ostatní včetně timeoutu = pád. Každé selhání vede u nepotvrzených dokladů na
  `neprovedeno` a **zastaví další dávky téže firmy** (stav firmy je nejistý; ostatní firmy se
  zpracují dál). V reportu je důvod u firmy jako `preruseno`.
- **Předběžná kontrola `FIRMA.LCK`** před sestavením dávky. Zámek vzniklý až po ní zachytí exit 3
  (Kaktus zámek kontroluje jen na začátku importu).
- **Pravda je DBF.** Po každé dávce (i po pádu nebo bez odpovědi) se firma načte znovu a každý
  doklad se určí podle nesmazaného záznamu s `TAXY:<id>`: nalezen = `zapsano` (číslo dokladu z DBF);
  nenalezen + odpověď s kódem `Ennn` = `chyba_kaktusu` (kód a text z odpovědi); jinak `neprovedeno`.
  Rozpor odpovědi s DBF (odpověď hlásí chybu, ale doklad v DBF je; jiné číslo dokladu) je varování
  u dokladu. Odpověď „OK“, ale v DBF nic = `neprovedeno` + varování (nikdy `zapsano` bez důkazu).
- **Doklad bez výsledku v odpovědi** (chybí `Doklad`, odpověď nečitelná nebo neexistuje) a bez zápisu
  v DBF je `neprovedeno`, i když import skončil exit 0; další dávky téže firmy se pak nezkouší.
  Při dalším běhu se doklad zkusí znovu (je to bezpečné, dedup ho nezapíše dvakrát).
- **Přeplánování mezi dávkami.** Před každou dávkou (max. 20 dokladů) se data firmy načtou znovu
  a dávka projde znovu `planWrite` (autorizace, dedup podle značky i čísla). Co se mezitím objevilo
  v Kaktusu, se nezapisuje.
- **`chyba_kaktusu` se při každém běhu zkouší znovu** (např. DUZP 2025 / E220), protože v DBF po
  sobě nic nenechá a vstup se může opravit. Exit je přesto 0 (je to definitivní odpověď Kaktusu).
- **Parser odpovědi** odmítá `<!DOCTYPE`/`<!ENTITY`, komentáře, CDATA, processing instructions mimo
  úvodní deklaraci, neznámé elementy, text mimo elementy, `&` mimo pět entit a platné číselné
  odkazy, duplicitní atributy, `poradi` mimo 1..počet dávky nebo duplicitní, jinou `firma` než ta,
  do které se importovalo, a odpověď nad 1 MiB. Neznámé atributy ignoruje. Kódování podle
  deklarace (Win-1250, jak píše simulátor; UTF-8 také). Chyba parseru = odpověď se nepoužije,
  rozhodne DBF.
- **Načtení dat firem před plánem:** jen firmy, na které odkazuje `klienti.json` a které jsou ve
  `FIRMY.DBF` nesmazané. Neexistující/smazaná firma se do plánu nedostane (doklady `odmitnuto`).
  Nečitelná data existující firmy = exit 1 před zápisem (poškozená firma se nesmí tvářit jako
  „neexistující“ a tím doklady odmítnout).
- **Nečekaná výjimka uvnitř jedné firmy** se zachytí. Import už mohl doběhnout, proto se
  rozpracovaná dávka ověří podle čerstvě načteného FAKPRI (`reconcileDavka`): doklady se značkou
  jsou `zapsano`, ostatní `neprovedeno`. Jen když nejde načíst ani FAKPRI, jsou `neprovedeno` všechny
  nezpracované doklady firmy. Report se přesto zapíše a ostatní firmy se zpracují.
- **Report** (`format: 1`) je bez časového razítka (deterministický, bajtově shodný při stejných
  datech): `rezim` (`zapis`/`dry-run`), `souhrn` (celkem, počty podle stavů, po firmách včetně
  `preruseno`) a `doklady[]` v pořadí vstupu s klíči `id, klientId, firma, stav, kaktusDoklad?,
  kod?, duvod?, varovani[]`. Obsahuje jen identifikátory, stavy a texty hlášek, nikdy bankovní účty
  ani celé doklady. V `--dry-run` mají doklady k zápisu stav `k_zapisu`; nic se nespouští ani
  nezapisuje (nevyžaduje ani `kaktus.cjs`).
- **Exit kódy `zapis`:** 0 vše zpracováno (i s `odmitnuto` a `chyba_kaktusu`), 1 chybný vstup nebo
  konfigurace, 2 něco `neprovedeno`. Report se zapíše i při exit 2.
- **Cíl `--out` se ověří před jakýmkoli importem** (`assertOutputWritable`): nadřazená složka musí
  existovat (nevytváří se – překlep v cestě by jinak založil nechtěnou složku), cíl nesmí být složka
  a do složky se musí dát zapisovat (zkušební `mkdtemp`); jinak exit 1 bez zápisu do Kaktusu.
  (Příkaz `cist` nic neimportuje a nadřazené složky dál vytváří.) Když se zápis reportu přesto
  nepodaří až po importu, výsledek se nesmí ztratit: souhrn a seznam dokladů (`id`, stav, číslo
  dokladu) jde na stdout, chyba na stderr a exit kód je **2** (v Kaktusu už něco může být, spuštění
  lze bezpečně zopakovat – doklady budou `jiz_zapsano`). V `--dry-run` je to běžná chyba výstupu (exit 1).
- **Velikost dávky** (`ZapisOpts.maxDavka`, jen pro testy) musí být celé číslo 1–20, jinak
  `VstupniChyba` ještě před čímkoli dalším (0 by zacyklilo zápis, >20 by Kaktus potichu ignoroval).
- `main()` v `cli.ts` je od teď asynchronní (`Promise<number>`), protože import běží přes
  asynchronní `execFile`.
