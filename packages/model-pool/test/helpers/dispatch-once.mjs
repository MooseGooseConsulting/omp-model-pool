// Drives the built extension through <iterations> subagent dispatches in its
// own OS process and prints every pick. Run several of these concurrently
// against one state file to exercise the cross-process lock for real.
//
// argv: <stateFile> <role> <comma-separated models> [persist=on|off] [iterations]
//       [--main-rotation-gated]
//
// `--main-rotation-gated` runs one main-session startup rotation instead. Its
// `setModel` reports the model it was asked to apply over the IPC channel and
// then blocks until the parent releases the pick — the release explicitly
// carrying the accept/refuse result — so the test can observe the durable
// state while the pick is applied but not yet committed.
import * as path from "node:path";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");

const stateFile = process.argv[2];
const role = process.argv[3] ?? "slow";
const models = (process.argv[4] ?? "").split(",").filter(Boolean);
const persist = (process.argv[5] ?? "on") !== "off";
const iterations = Number.parseInt(process.argv[6] ?? "1", 10) || 1;
const gated = process.argv.includes("--main-rotation-gated");

// Contention probe: the parent must be able to observe — deterministically, no
// sleeps — that a second gated child actually attempted the state-file lock
// while the first child still holds it. The extension acquires that lock with
// `fs.mkdirSync`, so a pass-through wrapper reports the first refusal over IPC
// and otherwise leaves every call exactly as it was.
if (gated) {
  const realMkdirSync = fsDefault.mkdirSync;
  const lockPath = stateFile === undefined ? undefined : `${stateFile}.lock`;
  let reported = false;
  fsDefault.mkdirSync = function observedMkdirSync(p, options) {
    try {
      return realMkdirSync(p, options);
    } catch (err) {
      if (p === lockPath && !reported) {
        reported = true;
        try {
          process.send({ type: "lock-contended" });
        } catch {
          // A closed channel surfaces through the parent's exit handling.
        }
      }
      throw err;
    }
  };
  syncBuiltinESMExports();
}

const mod = await import(pathToFileURL(dist).href);

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
  // The host's model application is the gate: it reports the model the parent
  // asked it to apply over IPC and only settles once the parent releases the
  // pick. The release explicitly carries the desired accept/refuse result, an
  // unexpected message rejects (a race must fail loudly, not resolve), and a
  // parent that dies or closes the channel rejects too — a gated pick must
  // never hang waiting on a channel nobody is listening to.
  pi.setModel = (model) => {
    acceptedModel = model;
    return new Promise((resolve, reject) => {
      const settle = (message) => {
        process.removeListener("disconnect", onChannelGone);
        if (message === null || typeof message !== "object" || message.type !== "release") {
          reject(new Error(`main rotation gate: unexpected parent message ${JSON.stringify(message)}`));
          return;
        }
        if (typeof message.accept !== "boolean") {
          reject(new Error(`main rotation gate: release must carry a boolean accept result, got ${JSON.stringify(message.accept)}`));
          return;
        }
        resolve(message.accept);
      };
      const onChannelGone = () => {
        process.removeListener("message", settle);
        reject(new Error("main rotation gate: parent disconnected before releasing the pick"));
      };
      process.once("message", settle);
      process.once("disconnect", onChannelGone);
      process.send({ type: "in-set-model", model: `${model.provider}/${model.id}` });
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
    // The handler returns the spawn's failover chain; the process report keeps
    // the first entry, which is the model this pick actually starts on.
    picks.push(Array.isArray(result?.model) ? (result.model[0] ?? null) : (result?.model ?? null));
  }
}

process.stdout.write(`${JSON.stringify({ pid: process.pid, model: picks[0] ?? null, picks })}\n`);
if (process.channel) process.disconnect();
