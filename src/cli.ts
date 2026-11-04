import { createInterface } from "node:readline";
import { Store } from "./store.ts";
import { execute } from "./query.ts";
const directory = process.argv[2] || "data";
let store: Store;
try {
  store = new Store(directory);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const interactive = Boolean(process.stdin.isTTY);
const lines = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: interactive,
});
if (interactive) {
  console.log(
    'Keystone / a small database with durable intentions.\nSET "user:1" {"name":"Alex"} · GET "user:1" · SCAN "user:" · COMPACT · STATS · EXIT',
  );
  lines.setPrompt("keystone> ");
  lines.prompt();
}
lines.on("line", (line) => {
  if (/^EXIT$/i.test(line.trim())) {
    lines.close();
    return;
  }
  if (!line.trim()) {
    if (interactive) lines.prompt();
    return;
  }
  try {
    console.log(
      JSON.stringify(execute(store, line), null, interactive ? 2 : 0),
    );
  } catch (e) {
    console.error(JSON.stringify({ error: (e as Error).message }));
    if (!interactive) process.exitCode = 1;
  }
  if (interactive) lines.prompt();
});
lines.on("close", () => store.close());
process.on("SIGTERM", () => {
  lines.close();
});
