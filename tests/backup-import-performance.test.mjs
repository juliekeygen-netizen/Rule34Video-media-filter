import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("backup Merge reuses the rollback snapshot instead of reading the same large stores twice", () => {
  const base = read("src/storage/settings-data.js");
  const hardening = read("src/storage/settings-data-hardening.js");
  assert.match(base, /async function mergeDatabase\(databasePayload, \{ currentDatabase = null \} = \{\}\)/);
  assert.match(base, /const current = currentDatabase \?\? await readStores\(/);
  assert.match(hardening, /base\.mergeDatabase\(backup\.database, \{ currentDatabase: previousDatabase \}\)/);
});

test("backup summaries can be derived directly from an already-built backup without another IndexedDB read", () => {
  const source = read("src/storage/settings-data.js");
  assert.match(source, /function summaryFromBackup\(backup = \{\}\)/);
  assert.match(source, /async function summary\(\) \{\s*return summaryFromBackup\(await buildBackup\(\)\);\s*\}/);
  assert.match(source, /summaryFromBackup,/);
});
