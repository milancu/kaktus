import * as fs from "node:fs";
import * as path from "node:path";
import { VstupniChyba } from "./errors";

/** Smaže dočasný adresář; selhání (EBUSY/EPERM…) se ignoruje, aby neshodilo už hotovou práci. */
function removeTmpBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // zůstane prázdný/dočasný adresář vedle cíle; výsledek zápisu se tím nemění
  }
}

/**
 * Atomicky zapíše text do souboru: dočasný soubor vznikne v unikátním adresáři (`fs.mkdtemp`)
 * ve stejné složce jako cíl, a poté se přejmenuje na cíl. Čtenář tak nikdy neuvidí napůl
 * zapsaný soubor. Nadřazené složky se případně vytvoří. Úklid dočasného adresáře je best-effort
 * (po úspěšném přejmenování nesmí selhání úklidu zápis „zneplatnit“).
 */
export function writeFileAtomic(file: string, content: string): void {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(dir, ".tmp-"));
  const tmpFile = path.join(tmpDir, "data");
  try {
    const fd = fs.openSync(tmpFile, "wx", 0o644);
    try {
      fs.writeSync(fd, content, 0, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, target);
  } finally {
    removeTmpBestEffort(tmpDir);
  }
}

/** Atomicky zapíše JSON (UTF-8, odsazení 2 mezery, koncový nový řádek). */
export function writeJsonAtomic(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Ověří cíl výstupního souboru ještě před jakoukoli prací s Kaktusem: nadřazená složka existuje
 * a je do ní možné zapisovat (zkušební `mkdtemp`) a cíl není složka. Zápis reportu po importu
 * by jinak mohl selhat, když už jsou doklady v Kaktusu zapsané.
 */
export function assertOutputWritable(file: string): void {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  let dirOk = false;
  try {
    dirOk = fs.statSync(dir).isDirectory();
  } catch {
    // nenalezeno / nedostupné
  }
  if (!dirOk) throw new VstupniChyba(`Složka pro výstup "${dir}" neexistuje.`);
  let targetIsDir = false;
  try {
    targetIsDir = fs.statSync(target).isDirectory();
  } catch {
    // cíl zatím neexistuje – v pořádku
  }
  if (targetIsDir) throw new VstupniChyba(`Výstup "${target}" je složka, očekává se soubor.`);
  try {
    removeTmpBestEffort(fs.mkdtempSync(path.join(dir, ".tmp-")));
  } catch {
    throw new VstupniChyba(`Do složky "${dir}" nelze zapisovat.`);
  }
}
