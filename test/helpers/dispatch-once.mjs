// Spawns exactly one subagent dispatch through the built extension and prints
// the picked model. Run as its own OS process to prove cross-process rotation.
//
// argv: <stateFile> <role> <comma-separated models> [persist=on|off]
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stateFile = process.argv[2];
const role = process.argv[3] ?? "slow";
const models = (process.argv[4] ?? "").split(",").filter(Boolean);
const persist = (process.argv[5] ?? "on") !== "off";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const mod = await import(pathToFileURL(dist).href);

let handler;
const pi = {
  on: (event, h) => {
    if (event === "before_subagent_spawn") handler = h;
  },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};
mod.default(pi, { pools: { [role]: models }, persistCounters: persist, stateFile });

const parsed = models.map((s) => {
  const i = s.indexOf("/");
  return i >= 0 ? { provider: s.slice(0, i), id: s.slice(i + 1) } : { provider: "", id: s };
});
const ctx = {
  agent: { kind: "sub", name: "task", id: "1" },
  models: {
    list: () => parsed.map((m) => ({ ...m })),
    current: () => undefined,
    resolve: (spec) => {
      const t = String(spec).trim();
      if (t.startsWith("@")) return undefined;
      const found = parsed.find((m) => `${m.provider}/${m.id}` === t || m.id === t);
      return found ? { ...found } : undefined;
    },
  },
  ui: { notify: () => {} },
};

const result = await handler(
  { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: `@${role}`, patterns: [`@${role}`] },
  ctx,
);
process.stdout.write(`${JSON.stringify({ pid: process.pid, model: result?.model ?? null, note: result?.note ?? null })}\n`);
