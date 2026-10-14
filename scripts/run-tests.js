// Spustí vestavěný runner (`node --test`) nad zkompilovanými testy v build-test/.
// Globy za nás nerozbaluje shell (cmd na Windows to neumí), proto soubory hledáme sami.
// Čisté JS, jen API dostupná v Node 18.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "build-test", "test");

function findTests(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTests(full));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) found.push(full);
  }
  return found.sort();
}

if (!fs.existsSync(testDir)) {
  console.error("Složka build-test/test neexistuje – spusťte nejdřív `npm run build:test`.");
  process.exit(1);
}
const files = findTests(testDir);
if (files.length === 0) {
  console.error("Nenalezen žádný soubor *.test.js v build-test/test.");
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (res.error) {
  console.error("Spuštění testů selhalo: " + res.error.message);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
