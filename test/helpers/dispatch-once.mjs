// Drives the built extension through <iterations> subagent dispatches in its
// own OS process and prints every pick. Run several of these concurrently
// against one state file to exercise the cross-process lock for real.
//
// argv: <stateFile> <role> <comma-separated models> [persist=on|off] [iterations]
//       [--main-rotation-gated]
//
// `--main-rotation-gated` runs one main-session startup rotation instead. Its
// `setModel` reports the model the host accepted over the IPC channel and then
// blocks until the parent sends "release", so the test can observe the durable
// state while the pick is accepted but not yet committed.
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const mod = await import(pathToFileURL(dist).href);

const stateFile = process.argv[2];
const role = process.argv[3] ?? "slow";
const models = (process.argv[4] ?? "").split(",").filter(Boolean);
const persist = (process.argv[5] ?? "on") !== "off";
const iterations = Number.parseInt(process.argv[6] ?? "1", 10) || 1;
const gated = process.argv.includes("--main-rotation-gated");

let subagentHandler;
let sessionStartHandler;
let acceptedModel;
const pi = {
  on: (event, h) => {
    if (event === "before_subagent_spawn") subagentHandler = h;
    if (event === "session_start") sessionStartHandler = h;
  },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};
if (gated) {
  // The host's model application is the gate: it reports the accepted model
  // over IPC and only settles once the parent releases the pick.
  pi.setModel = (model) => {
    acceptedModel = model;
    return new Promise((resolve) => {
      process.send({ type: "in-set-model", model: `${model.provider}/${model.id}` });
      process.once("message", (message) => resolve(message === "release"));
    });
  };
}

mod.default(pi, { pools: { [role]: models }, persistCounters: persist, stateFile, mainSessionRole: role });

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
if (gated) {
  // One main-session startup rotation; the state-file commit happens inside
  // this call, after the gate opens.
  const mainCtx = {
    ...ctx,
    agent: { kind: "main", name: "main", id: "main" },
    sessionManager: {
      getHeader: () => ({ timestamp: new Date(Date.now() - 5).toISOString() }),
      getEntries: () => [],
    },
  };
  await sessionStartHandler({ type: "session_start" }, mainCtx);
  picks.push(
    acceptedModel
      ? `${acceptedModel.provider}/${acceptedModel.id}`
      : null,
  );
} else {
  for (let i = 0; i < iterations; i++) {
    const result = await subagentHandler(event, ctx);
    picks.push(result?.model ?? null);
  }
}

process.stdout.write(`${JSON.stringify({ pid: process.pid, model: picks[0] ?? null, picks })}\n`);
if (process.channel) process.disconnect();
