# Před nasazením do produkce

Co se nevešlo do 3hodinového rozsahu úkolu. Orchestrátor sem průběžně doplňuje, co během
práce vypadlo z plánu.

- Ověřit na skutečném `KAKTUS.EXE` a reálných datech (kódování, chování zámku, limit dávky, exit kódy).
- Vlastní zámek proti souběžnému běhu konektoru nad stejnou firmou (číslování `FP26nnnn` má race).
- Záloha DBF před importem a postup obnovy; detekce poškozeného DBF po výpadku proudu.
- Čtení DBF, zatímco do něj Kaktus zapisuje (sharing violation na Windows) – retry s backoffem.
- Otevřené účetní období zjistit dopředu (kde ho Kaktus drží) místo spoléhání na E220.
- Politika pro smazané doklady se stejným číslem a pro varování (ořez, transliterace) – má je schválit účetní?
- Kontrolní součet IČO (mod 11), validace DIČ, kontrola plátce DPH u dodavatele.
- Hlášení výsledků zpět na server TAXY včetně stavu „nedokončeno“ a automatický retry.
- Telemetrie a monitoring napříč stovkami kanceláří; verzování modulu a detekce verze Kaktusu.
- Velká data (tisíce faktur – DBF se přepisuje celý při každém appendu), výkon a timeouty.
- Další typy dokladů (vydané faktury), dobropisy (záporné částky), zaokrouhlení jako samostatná položka.
- Záložní dedup podle `CISLODOD` porovnává po ořezu na 20 znaků – dvě čísla dokladu lišící se až za 20. znakem se tváří jako duplicita (doklad má varování o ořezu). Řešit s TAXY (delší pole jinde v Kaktusu?).
- Nízké nálezy z re-review (nevešly se do rozpočtu):
  - Dva doklady se stejným číslem ve stejné dávce, jeden s IČO a novým názvem, druhý bez IČO se starým názvem partnera v Kaktusu → zapíšou se oba (výsledek závisí na rozdělení do dávek). Návrh: doklady se stejným číslem dokladu dodavatele nedávat do jedné dávky.
  - Stejný dodavatel + číslo, kde jeden doklad má smazanou značku `TAXY:` v Kaktusu: výsledek závisí na pořadí ve vstupu. Návrh: předpočítat „konečně odmítnuté“ dvojice dodavatel+číslo před plánováním.
  - Text důvodu „Nečekaná chyba po spuštění importu“ i u chyb před spuštěním importu (stav `neprovedeno` je správně).
- Shoda dodavatele „s IČO / bez IČO podle názvu“ není tranzitivní – při zápisu dokladu bez IČO mohou být doklady dvou různých IČO se stejným názvem a číslem odmítnuty jako duplicita (raději nezapsat než zapsat dvakrát). Ověřit s TAXY.
