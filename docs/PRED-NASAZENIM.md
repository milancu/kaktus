# Před nasazením do produkce

Co se do rozsahu úkolu nevešlo, seřazené podle důležitosti.

## Nutné před prvním nasazením

1. **Ověřit na skutečném `KAKTUS.EXE`** a reálných datech: kódování, zámek firmy, limit 20 dokladů,
   exit kódy. Celé řešení stojí na tom, že se simulátor chová jako skutečný program.
2. **Zabránit dvěma konektorům nad stejnou firmou zároveň.** Oba by si spočítaly stejné další číslo
   dokladu `FP26nnnn` a mohly by si navzájem přepsat zápis.
3. **Zálohovat DBF před importem** a po výpadku proudu umět poznat poškozený soubor.
4. **Hlásit výsledek na server TAXY** včetně stavu „nedokončeno“ a takové doklady automaticky
   zkusit znovu.

## Brzy potom

5. Když má Kaktus DBF zrovna otevřený a Windows ho nedovolí přečíst, zkusit to za chvíli znovu.
6. Zjistit otevřené účetní období z Kaktusu dopředu, ne až z chyby E220.
7. Domluvit s TAXY, jestli má varování (oříznutý text, nahrazený znak, smazaný doklad se stejným
   číslem) schvalovat účetní.
8. Sledovat, jak konektor běží u všech kanceláří, a poznat, jakou verzi Kaktusu kancelář má.

## Rozšíření

- Vydané faktury, dobropisy (záporné částky), zaokrouhlení jako samostatná položka.
- Kontrola překlepu v IČO (poslední číslice je kontrolní), kontrola DIČ a toho, jestli je dodavatel
  plátce DPH.
- Výkon u velkých firem: Kaktus při každém zapsaném dokladu přepisuje celý DBF soubor.

## Známé drobné chyby

Vzácné okrajové případy, které se nevešly do času. U všech kromě prvního program raději doklad
nezapíše, než aby ho zapsal dvakrát.

- Dva doklady se stejným číslem ve stejné dávce, jeden s IČO a novým názvem dodavatele, druhý bez
  IČO se starým názvem: zapíšou se oba. Oprava: doklady se stejným číslem nedávat do jedné dávky.
- Čísla dokladů, která se liší až za 20. znakem, program bere jako stejná (Kaktus číslo ořízne na
  20 znaků). Druhý se nezapíše, v reportu je varování.
- Dva různí dodavatelé se stejným názvem a stejným číslem faktury, z nichž jeden nemá IČO: program je
  bere jako duplicitu a druhou fakturu nezapíše.
- Když má doklad stejného dodavatele a číslo jako náš doklad, který účetní smazala, výsledek záleží
  na pořadí dokladů ve vstupu.
- Hláška „Nečekaná chyba po spuštění importu“ se ukáže i u chyby, která nastala před spuštěním
  importu. Stav dokladu je správně.
