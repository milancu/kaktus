// Minimální smoke test, aby `npm test` mělo co spustit. Další testy píše test-writer.
import test from "node:test";
import * as assert from "node:assert/strict";
import { decodeCp852 } from "../src/codec";

test("CP852: čeština se dekóduje správně", () => {
  // Č ř ů Ž ě – bajty v CP852
  const bytes = Uint8Array.from([0xac, 0xfd, 0x85, 0xa6, 0xd8]);
  assert.equal(decodeCp852(bytes), "ČřůŽě");
});
