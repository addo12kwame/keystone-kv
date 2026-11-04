import { Store, type Value } from "./store.ts";
/** Strings use JSON escaping. Commands intentionally form a small, explicit grammar. */
export function execute(store: Store, input: string): unknown {
  const command = input.trim();
  if (/^STATS$/i.test(command)) return store.stats();
  if (/^COMPACT$/i.test(command)) return store.compact();
  const match =
    /^(GET|SET|DELETE|HAS|SCAN)\s+("(?:[^"\\]|\\.)*")(?:\s+([\s\S]+))?$/i.exec(
      command,
    );
  if (!match)
    throw Error(
      'Use GET "key", SET "key" <JSON>, DELETE "key", HAS "key", SCAN "prefix" [LIMIT n], STATS, or COMPACT.',
    );
  const verb = match[1].toUpperCase();
  const key = JSON.parse(match[2]) as string;
  const rest = match[3];
  if (verb === "SET") {
    if (rest === undefined) throw Error("SET requires a JSON value.");
    const value = JSON.parse(rest) as Value;
    store.set(key, value);
    return { ok: true };
  }
  if (verb === "SCAN") {
    let limit = 100;
    if (rest !== undefined) {
      const n = /^LIMIT ([0-9]+)$/i.exec(rest);
      if (!n) throw Error('Use SCAN "prefix" LIMIT n.');
      limit = Number(n[1]);
    }
    return store.scan(key, limit).map(([key, value]) => ({ key, value }));
  }
  if (rest !== undefined)
    throw Error(`${verb} does not accept extra arguments.`);
  if (verb === "GET") {
    const value = store.get(key);
    return value === undefined ? { found: false } : { found: true, value };
  }
  if (verb === "HAS") return { exists: store.has(key) };
  return { deleted: store.delete(key) };
}
