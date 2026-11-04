import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  truncateSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export type Value =
  null | boolean | number | string | Value[] | { [key: string]: Value };
type Operation =
  { type: "set"; key: string; value: Value } | { type: "delete"; key: string };
type RecordEntry = { version: 1; sequence: number; operations: Operation[] };
const checksum = (payload: string) =>
  createHash("sha256").update(payload).digest("hex");
const encode = (entry: RecordEntry) => {
  const payload = JSON.stringify(entry);
  return Buffer.from(
    JSON.stringify({ payload, checksum: checksum(payload) }) + "\n",
  );
};
function validValue(value: unknown): value is Value {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validValue);
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.values(value).every(validValue);
  return false;
}
function validKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !key.length || Buffer.byteLength(key) > 1024)
    throw Error("Keys must contain 1–1024 UTF-8 bytes.");
}
function writeAll(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) throw Error("Write made no progress.");
    offset += n;
  }
}
/** One process owns the directory. WAL records are flushed before becoming visible. */
export class Store {
  private index = new Map<string, Value>();
  private sequence = 0;
  private fd = -1;
  private closed = false;
  private poisoned = false;
  private lockFd = -1;
  private directory: string;
  private wal: string;
  private lock: string;
  constructor(directory: string) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true });
    this.wal = path.join(this.directory, "store.wal");
    this.lock = path.join(this.directory, "LOCK");
    try {
      this.lockFd = openSync(this.lock, "wx", 0o600);
    } catch {
      throw Error(
        "Database is locked. Another process may own it. After a crash, verify no owner is running before removing LOCK.",
      );
    }
    try {
      writeAll(
        this.lockFd,
        Buffer.from(
          JSON.stringify({
            pid: process.pid,
            opened: new Date().toISOString(),
          }) + "\n",
        ),
      );
      fsyncSync(this.lockFd);
      this.recover();
      this.fd = openSync(this.wal, "a", 0o600);
      this.syncDirectory();
    } catch (e) {
      this.releaseLock();
      throw e;
    }
  }
  private syncDirectory() {
    const fd = openSync(this.directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private releaseLock() {
    if (this.lockFd >= 0) {
      closeSync(this.lockFd);
      this.lockFd = -1;
      unlinkSync(this.lock);
    }
  }
  private ready() {
    if (this.closed) throw Error("Database is closed.");
    if (this.poisoned)
      throw Error(
        "A write failed. Close and reopen the database before continuing.",
      );
  }
  private recover() {
    if (!existsSync(this.wal)) return;
    const data = readFileSync(this.wal);
    let start = 0;
    let previous = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      if (newline < 0) {
        truncateSync(this.wal, start);
        break;
      }
      const line = data.subarray(start, newline).toString("utf8");
      let entry: RecordEntry;
      try {
        const frame = JSON.parse(line);
        if (
          typeof frame.payload !== "string" ||
          frame.checksum !== checksum(frame.payload)
        )
          throw Error();
        entry = JSON.parse(frame.payload);
        if (
          entry.version !== 1 ||
          !Number.isSafeInteger(entry.sequence) ||
          entry.sequence <= previous ||
          !Array.isArray(entry.operations) ||
          entry.operations.length === 0
        )
          throw Error();
        for (const op of entry.operations) {
          validKey(op.key);
          if (op.type !== "set" && op.type !== "delete") throw Error();
          if (op.type === "set" && !validValue(op.value)) throw Error();
        }
      } catch {
        throw Error(
          `WAL corruption at byte ${start}. Refusing to silently discard a complete record.`,
        );
      }
      for (const op of entry.operations) this.apply(op);
      this.sequence = entry.sequence;
      previous = entry.sequence;
      start = newline + 1;
    }
  }
  private apply(op: Operation) {
    if (op.type === "delete") this.index.delete(op.key);
    else this.index.set(op.key, op.value);
  }
  get(key: string): Value | undefined {
    this.ready();
    validKey(key);
    const value = this.index.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  has(key: string) {
    this.ready();
    validKey(key);
    return this.index.has(key);
  }
  set(key: string, value: Value) {
    this.batch([{ type: "set", key, value }]);
  }
  delete(key: string) {
    const existed = this.has(key);
    this.batch([{ type: "delete", key }]);
    return existed;
  }
  batch(operations: Operation[]) {
    this.ready();
    if (
      !Array.isArray(operations) ||
      !operations.length ||
      operations.length > 1000
    )
      throw Error("A batch requires 1–1,000 operations.");
    let copy: Operation[];
    try {
      for (const op of operations) {
        validKey(op.key);
        if (op.type !== "set" && op.type !== "delete")
          throw Error("Invalid operation.");
        if (op.type === "set" && !validValue(op.value))
          throw Error("Values must be finite JSON values.");
      }
      copy = structuredClone(operations);
    } catch (e) {
      throw Error("Invalid batch: " + (e as Error).message);
    }
    const entry: RecordEntry = {
      version: 1,
      sequence: this.sequence + 1,
      operations: copy,
    };
    const bytes = encode(entry);
    if (bytes.length > 4 * 1024 * 1024)
      throw Error("A WAL record cannot exceed 4 MB.");
    try {
      writeAll(this.fd, bytes);
      fsyncSync(this.fd);
    } catch (e) {
      this.poisoned = true;
      throw e;
    }
    for (const op of copy) this.apply(op);
    this.sequence = entry.sequence;
  }
  scan(prefix = "", limit = 100): [string, Value][] {
    this.ready();
    if (
      typeof prefix !== "string" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10000
    )
      throw Error("Limit must be 1–10,000.");
    return [...this.index]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([key, value]) => [key, structuredClone(value)]);
  }
  stats() {
    this.ready();
    return {
      keys: this.index.size,
      sequence: this.sequence,
      walBytes: statSync(this.wal).size,
    };
  }
  compact() {
    this.ready();
    const temp = path.join(this.directory, `compact-${randomUUID()}.tmp`);
    let out = -1;
    const before = statSync(this.wal).size;
    try {
      out = openSync(temp, "wx", 0o600);
      let sequence = this.sequence;
      for (const [key, value] of this.index)
        writeAll(
          out,
          encode({
            version: 1,
            sequence: ++sequence,
            operations: [{ type: "set", key, value }],
          }),
        );
      if (!this.index.size)
        writeAll(
          out,
          encode({
            version: 1,
            sequence: ++sequence,
            operations: [{ type: "delete", key: "__compaction_empty__" }],
          }),
        );
      fsyncSync(out);
      closeSync(out);
      out = -1;
      renameSync(temp, this.wal);
      this.syncDirectory();
      closeSync(this.fd);
      this.fd = -1;
      this.fd = openSync(this.wal, "a", 0o600);
      this.sequence = sequence;
      return {
        beforeBytes: before,
        afterBytes: statSync(this.wal).size,
        keys: this.index.size,
      };
    } catch (e) {
      this.poisoned = true;
      throw e;
    } finally {
      if (out >= 0) closeSync(out);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd >= 0) {
      closeSync(this.fd);
      this.fd = -1;
    }
    this.releaseLock();
  }
}
