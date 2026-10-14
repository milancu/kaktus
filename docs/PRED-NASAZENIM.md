# Před nasazením do produkce

## Nutné

1. **Ověřit na skutečném `KAKTUS.EXE`** a reálných datech.
2. **Zabránit dvěma konektorům nad stejnou firmou zároveň.** Oba by si spočítaly stejné další číslo
   dokladu a mohly by si navzájem přepsat zápis.
3. **Zálohovat DBF před importem** a po výpadku proudu umět poznat poškozený soubor.
4. **Hlásit výsledek na server TAXY** včetně stavu „nedokončeno“ a takové doklady automaticky
   zkusit znovu.

## Další krok

Zjistit otevřené účetní období z Kaktusu dopředu, ne až z chyby E220.

## Neošetřený případ

Dva doklady se stejným číslem ve stejné dávce, jeden s IČO a novým názvem dodavatele, druhý bez
IČO se starým názvem: zapíšou se oba. Je to vzácné; oprava je nedávat doklady se stejným číslem
do jedné dávky.
