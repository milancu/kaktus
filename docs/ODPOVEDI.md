# Odpovědi na otázky ze zadání

## 1. Příkaz „zapiš doklad X do firmy Y“: co musí platit, aby ho Connector směl provést?

Firmu nikdy nebereme z příkazu ani z obsahu dokladu, ale jen z `klienti.json`: `klientId` tam musí být právě jednou a mapovat se na `kaktusFirma` ve tvaru čtyř číslic. Ta firma musí existovat ve `FIRMY.DBF` a nesmí být smazaná. IČO odběratele na dokladu, IČO klienta a `FIRMY.ICO` se musí všechna tři shodovat; při nesouladu doklad odmítneme a nehádáme. Teprve potom se doklad validuje (typ a stav schváleno, konečná čísla, povolené sazby DPH, limity délek, bezpečné `id`) a deduplikuje. Doklad, který kontrolou neprojde, se nezapíše nikam a v reportu je `odmitnuto` s důvodem.

## 2. Počítač se vypne uprostřed zápisu dávky: v jakém stavu jsme a co se stane po zapnutí?

Zápis v Kaktusu není atomický, takže může být zapsaná jen část dávky a odpověď chybí. Pravdou je DBF: po každé dávce a při dalším spuštění se FAKPRI načte znovu a každý doklad se určí podle poznámky `TAXY:<id>`. Doklady se značkou jsou `jiz_zapsano`, ostatní se zapíšou, takže nevznikne duplicita. Po pádu importu jsou nepotvrzené doklady `neprovedeno`, příkaz skončí s exit kódem 2 a je bezpečné ho spustit znovu. Nevyřešené riziko je poškozený DBF po výpadku proudu, který neumíme detekovat ani obnovit ze zálohy; je to v `docs/PRED-NASAZENIM.md`.
