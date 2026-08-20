import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("entity filter modals receive the complete vocabulary while rendering bounded result rails", async () => {
  const [controller, picker] = await Promise.all([
    read("src/content/filter-vocabulary-performance.js"),
    read("src/ui/entity-picker.js")
  ]);

  assert.match(controller, /MODAL_VOCABULARY_LIMIT\s*=\s*Number\.MAX_SAFE_INTEGER/);
  assert.match(
    controller,
    /filterEngine\.vocabulary\([\s\S]*source\.records,[\s\S]*source\.detailsById,[\s\S]*field,[\s\S]*"",[\s\S]*MODAL_VOCABULARY_LIMIT[\s\S]*\)/
  );

  // Search is performed inside the picker after the vocabulary has been handed
  // over, so truncating the controller payload to the default 60 would make any
  // lower-ranked tag/category/artist/uploader impossible to find.
  assert.match(picker, /const results = \(vocabulary\.values \?\? \[\]\)/);
  assert.match(picker, /\.filter\(\(item\) => !needle \|\| String\(item\.value\)\.toLocaleLowerCase\(\)\.includes\(needle\)\)/);
  assert.match(picker, /\.slice\(0, resultLimit\)/);
});

test("normal and Advanced entity surfaces share the same complete-vocabulary path", async () => {
  const controller = await read("src/content/filter-vocabulary-performance.js");
  assert.match(controller, /modal\?\.type === "normal" && ENTITY_SET\.has\(modal\.field\)/);
  assert.match(controller, /modal\?\.type === "advanced"/);
  assert.match(controller, /collectEntityFields\(modal\.draft\?\.items\)/);
  assert.deepEqual(
    [...controller.matchAll(/"(artist|uploader|categories|tags)"/g)].map((match) => match[1]).slice(0, 4),
    ["artist", "uploader", "categories", "tags"]
  );
});

test("Advanced lazy entity vocabulary reload preserves the live unsaved draft before reopening", async () => {
  const controller = await read("src/content/filter-vocabulary-performance.js");
  assert.match(controller, /function preserveLiveAdvancedDraft/);
  assert.match(controller, /__r34mfAdvancedDebug\?\.getDraft\?\.\(\)/);
  assert.match(controller, /instance\.filterModal = \{ \.\.\.instance\.filterModal, draft: liveDraft \}/);
  assert.match(
    controller,
    /queueMicrotask\(\(\) => \{[\s\S]*preserveLiveAdvancedDraft\(controller\);[\s\S]*controller\.openFilters\(\);[\s\S]*\}\)/
  );
});
