# Odpovědi na otázky ze zadání

## 1. Příkaz „zapiš doklad X do firmy Y“: co musí platit, aby ho Connector směl provést?

Příkaz musí být prokazatelně od serveru TAXY a pro tuto kancelář (ověřené spojení, příkaz určený této instalaci Connectoru); to řeší hotový Connector a modul to předpokládá. Firmu Y pak nesmí určovat příkaz ani obsah dokladu, ale jen seznam klientů kanceláře: `klientId` dokladu tam musí být právě jednou a mít přiřazenou firmu Y, která existuje a není smazaná ve `FIRMY.DBF`. IČO odběratele na dokladu, IČO klienta a IČO firmy v Kaktusu se musí shodovat; při jakémkoli nesouladu doklad odmítneme a nehádáme. Doklad musí být schválený, platný (povinná pole, částky, sazby, délky) a nesmí už v Kaktusu být (značka `TAXY:<id>` nebo stejný dodavatel a číslo dokladu). Firma nesmí být právě otevřená u účetní; jinak je výsledek `neprovedeno` a příkaz se zopakuje později.

## 2. Počítač se vypne uprostřed zápisu dávky: v jakém stavu jsme a co se stane po zapnutí?

Kaktus zapisuje doklady jeden po druhém a odpověď vytvoří až na konci, takže může být zapsaná jen část dávky a odpověď chybí. Výsledek bereme z DBF, ne z odpovědi: po každé dávce a při dalším spuštění se FAKPRI načte znovu a každý doklad se určí podle poznámky `TAXY:<id>`. Doklady se značkou jsou `jiz_zapsano`, ostatní se zapíšou, takže nevznikne duplicita. Po pádu importu jsou nepotvrzené doklady `neprovedeno`, příkaz skončí s exit kódem 2 a je bezpečné ho spustit znovu. Nevyřešené riziko je poškozený DBF po výpadku proudu, který neumíme detekovat ani obnovit ze zálohy; je to v `docs/PRED-NASAZENIM.md`.
