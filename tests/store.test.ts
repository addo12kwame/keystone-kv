import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { execute } from "../src/query.ts";
function fixture(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "keystone-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("persists JSON values, deletes, null, and ordered prefix scans", () =>
  fixture((dir) => {
    let s = new Store(dir);
    s.set("user:b", { name: "Maya" });
    s.set("user:a", null);
    s.set("other", false);
    s.delete("other");
    assert.deepEqual(s.scan("user:"), [
      ["user:a", null],
      ["user:b", { name: "Maya" }],
    ]);
    s.close();
    s = new Store(dir);
    assert.equal(s.get("user:a"), null);
    assert.equal(s.get("other"), undefined);
    assert.equal(s.stats().keys, 2);
    s.close();
  }));
test("batches validate before writing and replay as one record", () =>
  fixture((dir) => {
    let s = new Store(dir);
    const before = s.stats().walBytes;
    assert.throws(() =>
      s.batch([
        { type: "set", key: "ok", value: 1 },
        { type: "set", key: "", value: 2 },
      ]),
    );
    assert.equal(s.stats().walBytes, before);
    s.batch([
      { type: "set", key: "a", value: 1 },
      { type: "set", key: "b", value: 2 },
      { type: "delete", key: "a" },
    ]);
    assert.equal(s.stats().sequence, 1);
    s.close();
    s = new Store(dir);
    assert.equal(s.get("a"), undefined);
    assert.equal(s.get("b"), 2);
    s.close();
  }));
test("truncates only incomplete final records and preserves later appendability", () =>
  fixture((dir) => {
    let s = new Store(dir);
    s.set("a", 1);
    s.close();
    const file = path.join(dir, "store.wal"),
      size = readFileSync(file).length;
    appendFileSync(file, '{"payload":"torn');
    s = new Store(dir);
    assert.equal(s.stats().walBytes, size);
    s.set("b", 2);
    s.close();
    s = new Store(dir);
    assert.equal(s.get("b"), 2);
    s.close();
  }));
test("refuses checksum corruption in a complete record", () =>
  fixture((dir) => {
    const s = new Store(dir);
    s.set("a", 1);
    s.close();
    const file = path.join(dir, "store.wal");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace('checksum":"', 'checksum":"bad'));
    assert.throws(() => new Store(dir), /corruption/);
    writeFileSync(file, original);
    const recovered = new Store(dir);
    recovered.close();
  }));
test("compaction removes obsolete versions and tombstones, preserving data and sequence", () =>
  fixture((dir) => {
    let s = new Store(dir);
    for (let i = 0; i < 100; i++) s.set("counter", i);
    s.set("gone", true);
    s.delete("gone");
    const before = s.stats().sequence;
    const compact = s.compact();
    assert.ok(compact.afterBytes < compact.beforeBytes);
    assert.equal(s.get("counter"), 99);
    s.set("after", "safe");
    s.close();
    s = new Store(dir);
    assert.equal(s.get("counter"), 99);
    assert.equal(s.get("gone"), undefined);
    assert.equal(s.get("after"), "safe");
    assert.ok(s.stats().sequence > before);
    s.delete("counter");
    s.delete("after");
    s.compact();
    const sequence = s.stats().sequence;
    s.close();
    s = new Store(dir);
    assert.equal(s.stats().keys, 0);
    assert.equal(s.stats().sequence, sequence);
    s.close();
  }));
test("lock prevents concurrent owners and values are isolated from caller mutation", () =>
  fixture((dir) => {
    const s = new Store(dir);
    assert.throws(() => new Store(dir), /locked/);
    const value = { nested: [1] };
    s.set("a", value);
    value.nested.push(2);
    const read = s.get("a") as typeof value;
    read.nested.push(3);
    assert.deepEqual(s.get("a"), { nested: [1] });
    assert.throws(() => s.set("bad", Infinity));
    s.close();
    assert.throws(() => s.get("a"), /closed/);
  }));
test("query grammar rejects ambiguous commands and distinguishes null from missing", () =>
  fixture((dir) => {
    const s = new Store(dir);
    execute(s, 'SET "a b" null');
    assert.deepEqual(execute(s, 'GET "a b"'), { found: true, value: null });
    assert.deepEqual(execute(s, 'GET "missing"'), { found: false });
    assert.throws(() => execute(s, 'GET "a b" extra'));
    assert.throws(() => execute(s, 'SCAN "" LIMIT -1'));
    assert.throws(() => execute(s, 'SET "a" undefined'));
    assert.equal((execute(s, 'SCAN "" LIMIT 1') as unknown[]).length, 1);
    s.close();
  }));
test("acknowledged data survives process death; explicit stale-lock recovery", () =>
  fixture((dir) => {
    const source = new URL("../src/store.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import {Store} from ${JSON.stringify(source)}; const s=new Store(${JSON.stringify(dir)});s.set('durable',{ok:true});process.kill(process.pid,'SIGKILL');`,
    ]);
    assert.equal(child.signal, "SIGKILL");
    assert.throws(() => new Store(dir), /locked/);
    unlinkSync(path.join(dir, "LOCK"));
    const s = new Store(dir);
    assert.deepEqual(s.get("durable"), { ok: true });
    s.close();
  }));
