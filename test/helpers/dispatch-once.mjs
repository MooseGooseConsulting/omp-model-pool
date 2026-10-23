// Drives the built extension through <iterations> subagent dispatches in its
// own OS process and prints every pick. Run several of these concurrently
// against one state file to exercise the cross-process lock for real.
//
// argv: <stateFile> <role> <comma-separated models> [persist=on|off] [iterations]
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stateFile = process.argv[2];
const role = process.argv[3] ?? "slow";
const models = (process.argv[4] ?? "").split(",").filter(Boolean);
const persist = (process.argv[5] ?? "on") !== "off";
const iterations = Number.parseInt(process.argv[6] ?? "1", 10) || 1;

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
const event = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: `@${role}`, patterns: [`@${role}`] };

const picks = [];
for (let i = 0; i < iterations; i++) {
  const result = await handler(event, ctx);
  picks.push(result?.model ?? null);
}

process.stdout.write(`${JSON.stringify({ pid: process.pid, model: picks[0] ?? null, picks })}\n`);
