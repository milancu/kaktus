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
