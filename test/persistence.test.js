import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistence } from "../src/persistence.js";
import { QueueStore } from "../src/queueStore.js";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "qc-"));
  return { file: join(dir, "queue.json"), dir };
}

test("save writes a real JSON file and load reads it back", () => {
  const { file, dir } = tmpFile();
  try {
    const p = createPersistence(file);
    p.save({ waiting: [{ tokenNumber: 5 }], nextTokenNumber: 6 });
    assert.ok(existsSync(file));
    const loaded = p.load();
    assert.equal(loaded.nextTokenNumber, 6);
    assert.equal(loaded.waiting[0].tokenNumber, 5);
    assert.ok(!existsSync(`${file}.tmp`), "temp file should be renamed away");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save creates the parent directory if missing", () => {
  const { dir } = tmpFile();
  const nested = join(dir, "deep", "nested", "queue.json");
  try {
    const p = createPersistence(nested);
    p.save({ ok: true });
    assert.ok(existsSync(nested));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load returns null for a missing file and tolerates corrupt JSON", () => {
  const { file, dir } = tmpFile();
  try {
    const p = createPersistence(file);
    assert.equal(p.load(), null); // missing
    writeFileSync(file, "{ not valid json");
    assert.equal(p.load(), null); // corrupt -> null, no throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full round-trip: QueueStore -> persistence -> QueueStore preserves token counter", () => {
  const { file, dir } = tmpFile();
  try {
    const p = createPersistence(file);
    const s1 = new QueueStore();
    s1.addPatient("A");
    s1.addPatient("B");
    s1.callNext();
    p.save(s1.serialize());

    const s2 = new QueueStore();
    assert.ok(s2.load(p.load()));
    assert.equal(s2.snapshot().current.tokenNumber, 1);
    s2.addPatient("C");
    assert.equal(s2.snapshot().waiting.at(-1).tokenNumber, 3); // counter survived restart
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
