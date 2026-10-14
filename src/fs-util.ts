import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Atomicky zapíše text do souboru: dočasný soubor vznikne v unikátním adresáři (`fs.mkdtemp`)
 * ve stejné složce jako cíl, a poté se přejmenuje na cíl. Čtenář tak nikdy neuvidí napůl
 * zapsaný soubor. Nadřazené složky se případně vytvoří.
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Atomicky zapíše JSON (UTF-8, odsazení 2 mezery, koncový nový řádek). */
export function writeJsonAtomic(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}
