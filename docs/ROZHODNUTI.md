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
