import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mod = await import("../dist/index.js");
import * as fakeHost from "./helpers/fake-host.mjs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/** The spawn's first model: the chain is an array once the pool has alternatives. */
const headOf = (model) => (Array.isArray(model) ? model[0] : model);


// The shared registry from the fake host replaces this file's private
// duplicate matcher. `current()` is undefined unless a case seeds it, which is
// exactly the "host cannot report its active model" shape.
const makeModels = fakeHost.makeModels;

/** A `@slow` subagent spawn, the event shape OMP hands the routing hook. */
const SLOW_EVENT_FOR_SLOW = {
  type: "before_subagent_spawn",
  agent: "reviewer",
  invocationKind: "task",
  modelRole: "@slow",
  patterns: ["@slow"],
};

/** Patch the default `node:fs` export and push it into the ESM namespace. */
function patchRename(impl) {
  const original = nodeFs.renameSync;
  nodeFs.renameSync = impl(original);
  syncBuiltinESMExports();
  return () => {
    nodeFs.renameSync = original;
    syncBuiltinESMExports();
  };
}

function makeHarness() {
  const handlers = {};
  const logs = [];
  const notified = [];
  const setModels = [];
  // One ordered record across both setter kinds, for call-order assertions
  // ("setModel" / "setThinkingLevel:<level>").
  const order = [];
  const effortCalls = [];
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    setModel: async (m) => {
      setModels.push(m);
      order.push("setModel");
    },
    setThinkingLevel: (level) => {
      effortCalls.push(level);
      order.push(`setThinkingLevel:${level}`);
    },
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      debug: (...a) => logs.push(["debug", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
  };
  return { handlers, logs, notified, setModels, order, effortCalls, pi };
}

// The host applies a resolved `Model`, so assertions compare `provider/id`
// identities; the original values in `setModels` are kept for shape checks.
function appliedIds(setModels) {
  return setModels.map((m) =>
    m !== null && typeof m === "object" ? `${m.provider}/${m.id}` : String(m),
  );
}

// Drive a registered `session_start` handler exactly the way OMP does: one
// event object and one extension context.
function handleSessionStart(harness, ctx) {
  return harness.handlers.session_start({ type: "session_start" }, ctx);
}

function subCtx(models, agentKind = "sub") {
  return {
    agent: { kind: agentKind, name: "task", id: "1" },
    models,
    ui: { notify: () => {} },
  };
}

// A main session. `entries` and `header` model what the host reports at
// `session_start`: a header created before this process, or a user/assistant
// message, means the session was loaded rather than created by this process.
function mainCtx(models, entries = [], header, notified = []) {
  return {
    agent: { kind: "main", name: "main", id: "Main" },
    models,
    ui: { notify: (message, type) => notified.push([message, type]) },
    sessionManager: { getEntries: () => entries, getHeader: () => header },
  };
}

// A session header written well before this process: one that was loaded.
function loadedHeader() {
  return { type: "session", id: "s1", timestamp: new Date(Date.now() - 3_600_000).toISOString() };
}
// A header this process just wrote: the only proof that a session is new.
function freshHeader() {
  return { type: "session", id: "s2", timestamp: new Date().toISOString() };
}

beforeEach(() => {
  mod.resetCounters();
  delete process.env.OMP_MODEL_POOLS_JSON;
  delete process.env.OMP_MODEL_POOL_CONFIG;
  delete process.env.OMP_MODEL_POOL_STATE;
});

describe("per-role round robin", () => {
  it("cycles same agent through slow[0..2] then wraps", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] } });
    const models = makeModels(["p/a", "p/b", "p/c"]);
    const picks = [];
    for (let i = 0; i < 4; i++) {
      const r = handlers.before_subagent_spawn(
        { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
        subCtx(models),
      );
      picks.push(headOf(r.model));
      assert.match(r.note, /pool slow\[\d\/3\]: /);
    }
    assert.deepEqual(picks, ["p/a", "p/b", "p/c", "p/a"]);
  });

  it("shares one counter across different agents on the same role", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const models = makeModels(["p/a", "p/b"]);
    const ctx = subCtx(models);
    const r1 = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] }, ctx);
    const r2 = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "scout", invocationKind: "eval", modelRole: "@slow", patterns: ["@slow"] }, ctx);
    const r3 = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "task", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] }, ctx);
    assert.equal(headOf(r1.model), "p/a");
    assert.equal(headOf(r2.model), "p/b"); // agent name irrelevant
    assert.equal(headOf(r3.model), "p/a");
  });

  it("treats '@slow' and 'slow' pool keys identically", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { "@slow": ["p/a", "p/b"] } });
    assert.deepEqual(Object.keys(mod.getPools()), ["slow"]);
    const models = makeModels(["p/a", "p/b"]);
    const r = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
      subCtx(models));
    assert.equal(headOf(r.model), "p/a");
  });

  it("ignores wrapper option keys in a flat config", () => {
    const { pi } = makeHarness();
    // A flat map keeps its option keys at the top level; only real roles become
    // pools. `strict` is passed as an ARRAY on purpose: a scalar option is
    // dropped by the list normalizer anyway, so only an array would otherwise
    // masquerade as a role pool.
    mod.default(pi, { slow: ["p/a"], strict: ["slow"], persistCounters: false, mainSessionRole: "default" });
    assert.deepEqual(Object.keys(mod.getPools()), ["slow"]);
  });

  it("leaves unconfigured roles untouched", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    const r = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@fast", patterns: ["@fast"] },
      subCtx(makeModels(["p/a"])));
    assert.equal(r, undefined);
    assert.deepEqual(mod.getCounters(), {});
  });

  it("preserves explicit per-dispatch pins (no modelRole)", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const r = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["p/pinned"] },
      subCtx(makeModels(["p/a", "p/b"])));
    assert.equal(r, undefined);
    assert.deepEqual(mod.getCounters(), {});
  });

  it("filters unauthenticated entries and fails open when the pool empties", () => {
    const { pi, handlers, logs } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/missing"] } });
    const models = makeModels(["p/a"]); // p/missing not authenticated
    const r1 = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
      subCtx(models));
    assert.equal(headOf(r1.model), "p/a"); // filtered, single survivor cycles
    mod.resetCounters();
    mod.configurePools({ pools: { slow: ["p/gone"] } });
    const r2 = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
      subCtx(models));
    assert.equal(r2, undefined);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("empty pool")));
  });

  it("returns the pool as the spawn's failover chain, starting at the picked slot", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] } });
    const models = makeModels(["p/a", "p/b", "p/c"]);
    const spawn = () => handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models));
    // A single string would leave a failed call with no pool fallback; the
    // host treats every returned entry after the first as a retry.
    assert.deepEqual(spawn().model, ["p/a", "p/b", "p/c"]);
    assert.deepEqual(spawn().model, ["p/b", "p/c", "p/a"], "the chain rotates with the cursor");
    assert.deepEqual(spawn().model, ["p/c", "p/a", "p/b"]);
  });

  it("omits unavailable entries and folds duplicates from the failover chain", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/gone", "p/c", "p/a"] } });
    const models = makeModels(["p/a", "p/c"]);
    // `p/gone` is unauthenticated and `p/a` repeats: retrying either adds a
    // request that cannot succeed or cannot differ.
    assert.deepEqual(handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models)).model, ["p/a", "p/c"]);
  });

  it("returns a bare string when the pool has only one usable entry", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/gone"] } });
    const models = makeModels(["p/a"]);
    assert.equal(handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models)).model, "p/a");
  });

  it("keeps a stable phase when availability changes mid-cycle", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] } });
    const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] };
    let authenticated = ["p/a", "p/b"]; // p/c not authenticated yet
    const pick = () => headOf(handlers.before_subagent_spawn(ev, subCtx(makeModels(authenticated))).model);

    const picks = [pick(), pick(), pick()];
    authenticated = ["p/a", "p/b", "p/c"]; // p/c authenticates mid-cycle
    picks.push(pick(), pick(), pick());

    // Modding a filtered list re-phased here and emitted "…, p/a, p/a, p/b, p/c";
    // indexing the configured pool keeps the phase: no duplicate at the swap.
    assert.deepEqual(picks, ["p/a", "p/b", "p/a", "p/b", "p/c", "p/a"]);
    assert.ok(mod.getCounters().slow < 3, "cursor stays an index into the configured pool");
  });

  it("resetCounters mirrors an OMP restart", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const models = makeModels(["p/a", "p/b"]);
    const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] };
    assert.equal(headOf(handlers.before_subagent_spawn(ev, subCtx(models)).model), "p/a");
    mod.resetCounters(); // restart: in-memory counters are gone
    assert.equal(headOf(handlers.before_subagent_spawn(ev, subCtx(models)).model), "p/a");
  });
});

describe("main-session rotation", () => {
  it("advances the default pool once per main session_start, ignores subs", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"], default: ["p/x", "p/y"] } });
    const models = makeModels(["p/a", "p/b", "p/x", "p/y"]);
    const main = mainCtx(models, [], freshHeader());
    await handlers.session_start({ type: "session_start" }, main);
    await handlers.session_start({ type: "session_start" }, main);
    await handlers.session_start({ type: "session_start" }, main);
    assert.deepEqual(appliedIds(setModels), ["p/x", "p/y", "p/x"]);
    // Sub sessions (incl. depth-0 /tan clones, which are kind=sub) never rotate.
    const n = setModels.length;
    await handlers.session_start(
      { type: "session_start" },
      { agent: { kind: "sub", name: "sub", id: "s", depth: 0 }, models, ui: { notify: () => {} } },
    );
    assert.equal(setModels.length, n);
    // Subagent slow cycling is unaffected apart from shared counters on overlap.
    const r = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
      subCtx(models),
    );
    assert.equal(headOf(r.model), "p/a");
  });

  it("does not rotate when main-session rotation is disabled", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] }, enableMainSessionRotation: false });
    await handlers.session_start(
      { type: "session_start" },
      mainCtx(makeModels(["p/x", "p/y"]), [], freshHeader()),
    );
    assert.deepEqual(setModels, [], "enableMainSessionRotation:false keeps subagent cycling only");
  });

  it("does nothing when the main role pool is unconfigured", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    // A fresh session with no `default` pool: the handler must reach the pool
    // lookup and return, not bail out at the novelty guard.
    await handlers.session_start(
      { type: "session_start" },
      mainCtx(makeModels(["p/a"]), [], freshHeader()),
    );
    assert.deepEqual(setModels, []);
  });

  it("does not rotate a loaded/resumed main session", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const resumed = mainCtx(makeModels(["p/x", "p/y"]), [
      { type: "message", message: { role: "user", content: "an earlier turn" } },
    ]);
    await handlers.session_start({ type: "session_start" }, resumed);
    assert.deepEqual(setModels, [], "a restored conversation keeps its restored model");
  });

  it("rotates a new session whose entries are only non-conversational metadata", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    // A preceding `session_start` handler may already have called
    // `pi.appendEntry(...)`, which writes a `custom` entry; OMP runs lifecycle
    // handlers sequentially in extension order. Alongside session_init, title,
    // mode and usage records, none of these are a conversation, so a new
    // session must still rotate.
    const fresh = mainCtx(makeModels(["p/x", "p/y"]), [
      { type: "session_init", id: "e1" },
      { type: "custom", customType: "another-extension/state", data: { note: "startup" } },
      { type: "model_usage", purpose: "title", role: "tiny" },
      { type: "mode_change", id: "e2" },
      { type: "custom_message", customType: "widget", content: "hi", display: false },
    ], freshHeader());
    await handlers.session_start({ type: "session_start" }, fresh);
    assert.deepEqual(appliedIds(setModels), ["p/x"], "startup metadata is not a conversation");
  });

  it("does not treat a tool result as a restored conversation", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const fresh = mainCtx(makeModels(["p/x", "p/y"]), [
      { type: "message", message: { role: "toolResult", content: "output" } },
    ], freshHeader());
    await handlers.session_start({ type: "session_start" }, fresh);
    assert.deepEqual(appliedIds(setModels), ["p/x"], "only user/assistant turns mark a session as loaded");
  });

  it("does not rotate a resumed session whose saved entries are metadata only", async () => {
    // `/new`, pick a model, exit, resume. OMP calls ensureOnDisk() on an
    // explicit new session to preserve the boundary, so that session holds only
    // session_init/model_change and no conversation. Its header still carries
    // the original creation time, which is what marks it as loaded; rotating
    // here would overwrite the model the resume restored.
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const resumed = mainCtx(
      makeModels(["p/x", "p/y"]),
      [{ type: "session_init", id: "e1" }, { type: "model_change", model: "openai/gpt-5.2", id: "e2" }],
      loadedHeader()
    );
    await handlers.session_start({ type: "session_start" }, resumed);
    assert.deepEqual(setModels, [], "a restored model is never overwritten");
  });

  it("rotates a new session even when its transcript is already on disk", async () => {
    // `omp --session <path>` and `/new` both materialize a transcript for a
    // session that is genuinely new, so a file existing must not read as a
    // resume. The header timestamp is what decides.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-session-"));
    try {
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(sessionFile, "");
      const { pi, handlers, setModels } = makeHarness();
      mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
      const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init", id: "e1" }], freshHeader());
      ctx.sessionManager.getSessionFile = () => sessionFile; // present, and deliberately ignored
      await handlers.session_start({ type: "session_start" }, ctx);
      assert.deepEqual(appliedIds(setModels), ["p/x"], "a materialized transcript is not proof of a resume");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rotate when neither the header nor the entries are readable", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]));
    ctx.sessionManager.getHeader = () => {
      throw new Error("unreadable");
    };
    ctx.sessionManager.getEntries = () => {
      throw new Error("unreadable");
    };
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.deepEqual(setModels, [], "no signal means no guess");
  });

  it("does not rotate a session whose header timestamp is unusable", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init", id: "e1" }], { timestamp: "not-a-date" });
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.deepEqual(setModels, [], "an unparseable header is unknown, not new");
  });

  it("does not rotate when the host cannot report session novelty", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    await handlers.session_start(
      { type: "session_start" },
      { agent: { kind: "main", name: "main", id: "Main" }, models: makeModels(["p/x", "p/y"]), ui: { notify: () => {} } },
    );
    assert.deepEqual(setModels, [], "unknown novelty must not risk overriding a restored model");
  });

  // --- real-host apply contract -------------------------------------------------
  // The handler must hand the host a resolved Model and must not report a
  // rotation it did not achieve. The fake host previously accepted a string, so
  // these cases are what the old mock could not catch.

  it("applies the resolved model object and confirms the host took it", async () => {
    const { pi, handlers, setModels, logs, notified } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init" }], freshHeader(), notified);
    // Model a host that really applies the model rather than one whose
    // `current()` cannot confirm anything, so the confirmation path is exercised
    // positively instead of being skipped.
    pi.setModel = async (m) => {
      setModels.push(m);
      ctx.models.current = () => m;
    };
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.equal(setModels.length, 1);
    const applied = setModels[0];
    assert.equal(typeof applied, "object", "the host takes a Model, not a string");
    assert.equal(applied.provider, "p");
    assert.equal(applied.id, "x");
    assert.ok(
      logs.some(([l, m]) => l === "info" && m.includes("main session applied")),
      "success is logged once the host confirms the model",
    );
    assert.ok(
      notified.some(([m, t]) => t === "info" && m.includes("p/x")),
      "a confirmed rotation is toasted to the user",
    );
  });

  it("does not claim a rotation when the host refuses the model", async () => {
    const { pi, handlers, logs, notified } = makeHarness();
    pi.setModel = async () => false; // the host's "no credential for that model"
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init" }], freshHeader(), notified);
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("host refused")));
    assert.ok(!logs.some(([, m]) => m.includes("main session applied")), "a refusal is not a rotation");
    assert.ok(!notified.some(([, t]) => t === "info"), "a refusal is not toasted as a success");
  });

  it("does not claim a rotation when the registry stops resolving the pick between choose and apply", async () => {
    const { pi, handlers, logs } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init" }], freshHeader());
    // Filtering resolves each pool entry first, so the apply-time lookup is the
    // third call. Failing only there exercises the defensive branch for a
    // registry that changes under the handler; failing every call instead would
    // never reach it, because an unresolvable pool is empty and returns early.
    const real = ctx.models.resolve.bind(ctx.models);
    let seen = 0;
    ctx.models.resolve = (spec) => {
      seen += 1;
      return seen <= 2 ? real(spec) : null; // null, not undefined: the host may report either
    };
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("could not resolve")));
    assert.ok(!logs.some(([, m]) => m.includes("main session applied")));
  });

  it("tolerates a host that reports null instead of undefined, without claiming success", async () => {
    const { pi, handlers, logs, notified } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init" }], freshHeader(), notified);
    // `current()` returning null after a successful apply must not throw, and it
    // is not evidence of success either: the host never confirmed the model, so
    // the outcome is reported as unconfirmed rather than as a completed rotation.
    ctx.models.current = () => null;
    pi.setModel = async () => undefined;
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("did not confirm the active model")));
    assert.ok(!logs.some(([, m]) => m.includes("main session applied")));
    assert.ok(
      !logs.some(([, m]) => m.includes("session_start error")),
      "a null current model is a handled case, not an exception",
    );
    assert.ok(
      notified.some(([m, t]) => t === "warning" && m.includes("did not confirm the active model")),
      "the unconfirmed outcome reaches the user as a warning",
    );
    assert.ok(
      !notified.some(([, t]) => t === "info"),
      "an unconfirmed rotation is never toasted as a success",
    );
  });

  it("warns when the session keeps a different model than requested", async () => {
    const { pi, handlers, logs } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init" }], freshHeader());
    ctx.models.current = () => ({ provider: "other", id: "model" });
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("but the session reports")));
    assert.ok(!logs.some(([, m]) => m.includes("main session applied")));
  });

  it("survives a host that throws from setModel", async () => {
    const { pi, handlers, logs } = makeHarness();
    pi.setModel = async () => {
      throw new Error("boom");
    };
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"]), [{ type: "session_init" }], freshHeader());
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("threw; leaving model unchanged")));
  });
});

// A per-test state file under a fresh temporary directory, so tests never
// share on-disk state.
function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-pool-"));
  return { dir, file: path.join(dir, "model-pool-state.json") };
}

describe("cross-process counter persistence (opt-in)", () => {
  const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] };

  function tmpStateFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-"));
    return { dir, file: path.join(dir, "model-pool-state.json") };
  }

  it("continues the cycle across simulated restarts when enabled", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] }, persistCounters: true, stateFile: file });
      const models = makeModels(["p/a", "p/b", "p/c"]);
      const seen = [];
      for (let i = 0; i < 4; i++) {
        mod.resetCounters(); // each iteration is a fresh OS process: in-memory gone
        const r = await handlers.before_subagent_spawn(ev, subCtx(models));
        seen.push(headOf(r.model));
      }
      assert.deepEqual(seen, ["p/a", "p/b", "p/c", "p/a"]);
      // The cursor is stored modulo the pool length (3), so four picks land on 1.
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no state file and returns synchronously when disabled", () => {
    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, stateFile: file });
      const r = handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(headOf(r.model), "p/a"); // sync result, not a promise
      assert.equal(fs.existsSync(file), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails open on a malformed state file and does not reset it", async () => {
    const { dir, file } = tmpStateFile();
    try {
      fs.writeFileSync(file, "{ not json");
      const { pi, handlers, logs } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(headOf(r.model), "p/a"); // in-memory fallback still routes
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("persisted counter")));
      assert.equal(fs.readFileSync(file, "utf8"), "{ not json"); // untouched for the operator
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps in-process picks distinct (real cross-process contention is covered in cross-process.test.mjs)", async () => {    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const models = makeModels(["p/a", "p/b"]);
      const [r1, r2] = await Promise.all([
        handlers.before_subagent_spawn(ev, subCtx(models)),
        handlers.before_subagent_spawn(ev, subCtx(models)),
      ]);
      assert.deepEqual([headOf(r1.model), headOf(r2.model)].sort(), ["p/a", "p/b"]);
      // Stored modulo the pool length (2): two picks wrap back to 0.
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists main-session rotation on the same shared state file", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers, setModels } = makeHarness();
      mod.default(pi, { pools: { default: ["p/x", "p/y"] }, persistCounters: true, stateFile: file });
      const models = makeModels(["p/x", "p/y"]);
      const main = mainCtx(models, [], freshHeader());
      mod.resetCounters();
      await handlers.session_start({ type: "session_start" }, main);
      mod.resetCounters();
      await handlers.session_start({ type: "session_start" }, main);
      assert.deepEqual(appliedIds(setModels), ["p/x", "p/y"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a state file from an unknown schema (fail open, file untouched)", async () => {
    const { dir, file } = tmpStateFile();
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 3, counters: { slow: 5 } }));
      const { pi, handlers, logs } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(headOf(r.model), "p/a"); // falls back to in-memory, ignores the foreign cursor
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("persisted counter")));
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 3); // not overwritten
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a version-1 state file so persistence resumes", async () => {
    const { dir, file } = tmpStateFile();
    try {
      // v1 stored an unbounded running count, later reduced modulo the
      // *filtered* eligible list; v2 stores an index into the *configured*
      // pool. With [p/a, p/b, p/c] configured and p/c unavailable the two
      // disagree: 4 % 2 (v1, filtered) = 0, but 4 % 3 (v2, configured) = 1.
      // A fresh start must yield p/a, not p/b.
      fs.writeFileSync(file, JSON.stringify({ version: 1, counters: { slow: 4 } }));
      const { pi, handlers, logs } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] }, persistCounters: true, stateFile: file });
      const avail = subCtx(makeModels(["p/a", "p/b"])); // p/c unavailable

      const first = await handlers.before_subagent_spawn(ev, avail);
      assert.equal(headOf(first.model), "p/a"); // fresh cursor, not index 1 of a reinterpreted count
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("version-1 state file")));
      // The old file is preserved for inspection...
      assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.v1.bak`, "utf8")), { version: 1, counters: { slow: 4 } });
      // ...and the live file is now v2, so persistence has not been left dead.
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 2, counters: { slow: 1 } });

      // The proof that it resumed: the next pick continues from the replaced
      // cursor instead of restarting, which a merely-rejected file could not.
      const second = await handlers.before_subagent_spawn(ev, avail);
      assert.equal(headOf(second.model), "p/b");
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 2, counters: { slow: 2 } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects the whole state when a single counter entry is invalid", async () => {
    const { dir, file } = tmpStateFile();
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 2, counters: { slow: "4" } }));
      const { pi, handlers, logs } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(headOf(r.model), "p/a");
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("persisted counter")));
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, "4"); // untouched
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a state file with no declared version", async () => {
    const { dir, file } = tmpStateFile();
    try {
      fs.writeFileSync(file, JSON.stringify({ counters: { slow: 4 } }));
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(headOf(r.model), "p/a");
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { counters: { slow: 4 } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors persistCounters from a flat JSON config", async () => {
    const { dir, file } = tmpStateFile();
    try {
      process.env.OMP_MODEL_POOLS_JSON = JSON.stringify({ slow: ["p/a", "p/b"], persistCounters: true, stateFile: file });
      const { pi, handlers } = makeHarness();
      mod.default(pi); // no options: config comes from the environment
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(headOf(r.model), "p/a");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not enable persistence for a non-boolean persistCounters", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: "false", stateFile: file });
      const r = handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(headOf(r.model), "p/a");
      assert.equal(fs.existsSync(file), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("state file path resolution", () => {
  const ENV_KEYS = ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"];

  // Run `fn` with the OMP directory/profile vars set to exactly `vars`, so a
  // test is not perturbed by whatever the developer's shell exports.
  function withEnv(vars, fn) {
    const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    try {
      return fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("expands a leading ~ and never returns a literal ~ path", () => {
    const p = mod.resolveStateFilePath("~/custom/state.json");
    assert.ok(path.isAbsolute(p), p);
    assert.ok(!p.includes("~"), p);
    assert.equal(p, path.resolve(path.join(os.homedir(), "custom", "state.json")));
  });

  it("honors PI_CODING_AGENT_DIR as the base for relative and default paths", () => {
    const base = path.join(os.tmpdir(), "mmm-agent");
    withEnv({ PI_CODING_AGENT_DIR: base }, () => {
      assert.equal(mod.resolveStateFilePath("state.json"), path.resolve(base, "state.json"));
      assert.equal(mod.resolveStateFilePath(), path.join(path.resolve(base), "model-pool-state.json"));
    });
  });

  it("scopes the default state file to the active profile", () => {
    withEnv({ OMP_PROFILE: "work" }, () => {
      // Not ~/.omp/agent: a named profile relocates the agent dir, and sharing
      // the default profile's file would make two profiles share one cursor.
      assert.equal(
        mod.resolveStateFilePath(),
        path.join(os.homedir(), ".omp", "profiles", "work", "agent", "model-pool-state.json"),
      );
      assert.equal(
        mod.resolveStateFilePath("state.json"),
        path.join(os.homedir(), ".omp", "profiles", "work", "agent", "state.json"),
      );
    });
  });

  it("ignores PI_CODING_AGENT_DIR for a named profile", () => {
    withEnv({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: path.join(os.tmpdir(), "mmm-agent") }, () => {
      assert.equal(
        mod.resolveStateFilePath(),
        path.join(os.homedir(), ".omp", "profiles", "work", "agent", "model-pool-state.json"),
      );
    });
  });

  it("honors PI_CONFIG_DIR as the config root under a profile too", () => {
    withEnv({ OMP_PROFILE: "work", PI_CONFIG_DIR: "myconf" }, () => {
      assert.equal(
        mod.resolveStateFilePath(),
        path.join(os.homedir(), "myconf", "profiles", "work", "agent", "model-pool-state.json"),
      );
    });
  });

  it("treats an empty or default profile as the default profile", () => {
    // An explicitly-empty OMP_PROFILE selects the default profile rather than
    // inheriting the legacy PI_PROFILE.
    withEnv({ OMP_PROFILE: "", PI_PROFILE: "work" }, () => {
      const fallback = path.join(os.tmpdir(), "mmm-agent");
      process.env.PI_CODING_AGENT_DIR = fallback;
      assert.equal(mod.resolveStateFilePath(), path.join(path.resolve(fallback), "model-pool-state.json"));
    });
    withEnv({ OMP_PROFILE: "  default  " }, () => {
      assert.equal(mod.resolveStateFilePath(), path.join(os.homedir(), ".omp", "agent", "model-pool-state.json"));
    });
    withEnv({ PI_PROFILE: "work" }, () => {
      assert.equal(
        mod.resolveStateFilePath(),
        path.join(os.homedir(), ".omp", "profiles", "work", "agent", "model-pool-state.json"),
      );
    });
  });

  it("keeps an explicit stateFile authoritative under a profile", () => {
    withEnv({ OMP_PROFILE: "work" }, () => {
      const explicit = path.join(os.tmpdir(), "explicit-state.json");
      assert.equal(mod.resolveStateFilePath(explicit), path.resolve(explicit));
    });
  });
});

describe("strict policy boundary", () => {
  const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] };

  it("hard-blocks every role when strict is the boolean true", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/gone"] }, strict: true });
    const r = handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/other"])));
    assert.deepEqual(r, { block: true, reason: "model-pool: no authenticated model available for role @slow" });
  });

  it("does not hard-block when the registry read throws", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] }, strict: ["slow"] });
    const throwing = {
      agent: { kind: "sub" },
      models: { list: () => { throw new Error("registry down"); }, current: () => undefined, resolve: () => undefined },
      ui: { notify: () => {} },
    };
    assert.equal(handlers.before_subagent_spawn(ev, throwing), undefined);
  });

});

// A minimal deferred promise: a gate a test controls explicitly, without any
// clock dependency.
function deferred() {
  let release;
  const promise = new Promise((res) => { release = res; });
  return { promise, resolve: () => release() };
}

// ---------------------------------------------------------------------------
// Main-session acceptance gate (persistCounters + stateFile)
//
// A main-session pick is one serialized turn: peek the eligible slot, offer
// it to the host, and consume it only once the host accepts. These cases
// cover the acceptance/refusal boundary at the setModel step.
// ---------------------------------------------------------------------------
describe("main-session acceptance gate", () => {
  function setupRefusedPick() {
    const harness = makeHarness();
    const refused = deferred();
    harness.pi.setModel = async () => false; // the host refuses every apply
    return { harness, refused };
  }

  it("does not consume a slot when the host refuses the model", async () => {
    const { harness, refused } = setupRefusedPick();
    const { dir, file } = tmpStateFile();
    try {
      mod.default(harness.pi, { pools: { default: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(mod.getCounters(), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not consume a slot when setModel throws, and never retries it", async () => {
    const { dir, file } = tmpStateFile();
    try {
      let calls = 0;
      const harness = makeHarness();
      harness.pi.setModel = async () => {
        calls += 1;
        throw new Error("host exploded");
      };
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.equal(calls, 1, "a throwing host is never retried");
      assert.deepEqual(mod.getCounters(), {});
      assert.equal(fs.existsSync(file), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not consume a slot when the host exposes no setModel", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const harness = makeHarness();
      delete harness.pi.setModel;
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(mod.getCounters(), {});
      assert.equal(fs.existsSync(file), false);
      assert.ok(harness.logs.some(([l, m]) => l === "warn" && m.includes("setModel")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not consume a slot when the only entry is not authenticated", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // `p/b` resolves but is absent from `list()`: not authenticated.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a"]), [], freshHeader()));
      assert.deepEqual(harness.setModels, []);
      assert.deepEqual(mod.getCounters(), {});
      assert.equal(fs.existsSync(file), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not consume a slot when the registry read throws", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      const models = makeModels(["p/a", "p/b"]);
      models.list = () => {
        throw new Error("registry offline");
      };
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      assert.deepEqual(harness.setModels, []);
      assert.deepEqual(mod.getCounters(), {});
      assert.ok(
        harness.logs.some(([l, m]) => l === "warn" && m.includes("registryReadable=false")),
        "an unreadable registry is reported as such, not as authenticated-nothing",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consumes exactly one slot when the host cannot report its active model", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // `current()` is undefined: the apply is unconfirmed, not a failure.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a"]);
      assert.deepEqual(mod.getCounters(), { default: 1 });
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 1);
      assert.ok(
        harness.logs.some(([l, m]) => l === "warn" && m.includes("did not confirm")),
        "the unconfirmed apply is reported",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not consume a slot when the host keeps a different model", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // The seeded active model never changes, so applying `p/a` mismatches.
      const models = makeModels(["p/a", "p/b"], "p/b");
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a"]);
      assert.deepEqual(mod.getCounters(), {});
      assert.equal(fs.existsSync(file), false, "a mismatch writes no cursor");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues a same-role spawn behind the startup pick and gives it the next slot", async () => {
    const gate = deferred();
    let calls = 0;
    const harness = makeHarness();
    harness.pi.setModel = async () => {
      calls += 1;
      await gate.promise;
      return undefined;
    };
    mod.default(harness.pi, {
      pools: { slow: ["p/a", "p/b"] },
      mainSessionRole: "slow",
    });
    const models = makeModels(["p/a", "p/b"]);
    const startup = handleSessionStart(harness, mainCtx(models, [], freshHeader()));
    const spawn = harness.handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models));
    assert.equal(await Promise.race([spawn.then(() => "settled"), Promise.resolve("open")]), "open",
      "a same-role spawn waits for the startup pick to settle");
    gate.resolve();
    await startup;
    assert.equal(headOf((await spawn).model), "p/b", "the accepted pick consumed slot 0");
    assert.equal(calls, 1);
  });

  it("gives a queued same-role spawn the same slot when the startup pick is refused", async () => {
    const gate = deferred();
    const harness = makeHarness();
    harness.pi.setModel = async () => {
      await gate.promise;
      return false;
    };
    mod.default(harness.pi, {
      pools: { slow: ["p/a", "p/b"] },
      mainSessionRole: "slow",
    });
    const models = makeModels(["p/a", "p/b"]);
    const startup = handleSessionStart(harness, mainCtx(models, [], freshHeader()));
    const spawn = harness.handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models));
    gate.resolve();
    await startup;
    assert.equal(headOf((await spawn).model), "p/a", "a refusal consumed nothing, so the spawn sees slot 0");
  });

  it("does not block a different role while a startup pick is in flight", async () => {
    const gate = deferred();
    const harness = makeHarness();
    harness.pi.setModel = async () => {
      await gate.promise;
      return undefined;
    };
    mod.default(harness.pi, {
      pools: { slow: ["p/a", "p/b"], other: ["p/x"] },
      mainSessionRole: "slow",
    });
    const models = makeModels(["p/a", "p/b", "p/x"]);
    const startup = handleSessionStart(harness, mainCtx(models, [], freshHeader()));
    const other = await harness.handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "scout", invocationKind: "task", modelRole: "@other", patterns: ["@other"] },
      subCtx(models),
    );
    assert.equal(headOf(other?.model), "p/x", "an unrelated role is not serialized behind another role's turn");
    gate.resolve();
    await startup;
  });

  it("applies the model once and mirrors the cursor when the durable write fails", async () => {
    const { dir, file } = tmpStateFile();
    const restore = patchRename(() => () => {
      const err = new Error("denied");
      err.code = "EACCES";
      throw err;
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.equal(harness.setModels.length, 1, "the accepted model is applied exactly once");
      assert.deepEqual(mod.getCounters(), { default: 1 }, "the in-memory cursor mirrors the acceptance");
      assert.equal(fs.existsSync(file), false);
      assert.ok(
        harness.logs.some(([l, m]) => l === "warn" && /(could not be written|in-memory)/.test(m)),
        "the durable failure is reported instead of claimed as a rotation",
      );
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues from the in-memory cursor on the next startup when the write keeps failing", async () => {
    const { dir, file } = tmpStateFile();
    const restore = patchRename(() => () => {
      const err = new Error("denied");
      err.code = "EACCES";
      throw err;
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // Two fresh main sessions in ONE process: the second must not re-read the
      // stale state file and re-apply the slot the host already took.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/b"]);
      assert.equal(fs.existsSync(file), false);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns to the durable cursor once a write finally succeeds", async () => {
    const { dir, file } = tmpStateFile();
    let failing = true;
    const restore = patchRename((original) => (from, to) => {
      if (failing) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      failing = false;
      // The degraded role continues from the mirror, commits, and clears the mark.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 0);
      // The next startup is back on the file's cursor.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/b", "p/a"]);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers to a slot another process committed while this one was degraded", async () => {
    const { dir, file } = tmpStateFile();
    let failing = true;
    const restore = patchRename((original) => (from, to) => {
      if (failing) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // Two failed commits: a was applied (mirror -> b), then b (mirror -> a).
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      // Another process now commits slot b for itself: the file moves to 1.
      fs.writeFileSync(
        file,
        `${JSON.stringify({ version: 2, counters: { default: 1 } }, null, 2)}\n`,
        "utf8",
      );
      failing = false;
      // The mirror says "a" but the durable cursor says "b"; the durable write
      // wins, or this process would apply a slot someone else already took.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/b", "p/b"]);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 0);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a rewritten state file whose cursor wrapped back to the same value", async () => {
    const { dir, file } = tmpStateFile();
    const writeState = (cursor) =>
      fs.writeFileSync(
        file,
        `${JSON.stringify({ version: 2, counters: { default: cursor } }, null, 2)}\n`,
        "utf8",
      );
    writeState(0);
    let failing = true;
    const restore = patchRename((original) => (from, to) => {
      if (failing) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // One failed commit: a was applied, mirror points at b, disk still says 0.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a"]);
      // Another process commits a, then b: a full wrap puts the cursor back on
      // 0, but the bytes are new. Equality on the cursor would call this
      // "unchanged" and let this process apply b again.
      writeState(1);
      // Same cursor, different bytes: the rewrite must be detectable from the
      // file content itself, not from filesystem timestamp resolution.
      fs.writeFileSync(
        file,
        `${JSON.stringify({ version: 2, counters: { default: 0 }, rewritten: true }, null, 2)}\n`,
        "utf8",
      );
      failing = false;
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/a"]);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 1);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not carry a degraded mirror across a rebind to another state file", async () => {
    const first = tmpStateFile();
    const second = tmpStateFile();
    let failing = true;
    const restore = patchRename((original) => (from, to) => {
      if (failing) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: first.file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      failing = false;
      // Rebind to a different file: its own cursor is 0, so the first pick must
      // be slot 0 again rather than the mirror from the previous file.
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: second.file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/a"]);
      assert.equal(JSON.parse(fs.readFileSync(second.file, "utf8")).counters.default, 1);
    } finally {
      restore();
      fs.rmSync(first.dir, { recursive: true, force: true });
      fs.rmSync(second.dir, { recursive: true, force: true });
    }
  });

  it("keeps the mirror pinned to the read that failed even when a later pick is refused", async () => {
    const { dir, file } = tmpStateFile();
    const writeState = (cursor) =>
      fs.writeFileSync(
        file,
        `${JSON.stringify({ version: 2, counters: { default: cursor } }, null, 2)}\n`,
        "utf8",
      );
    writeState(0);
    let failing = true;
    const restore = patchRename((original) => (from, to) => {
      if (failing) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // Accepted a, durable write failed: mirror points at b, file still reads 0.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a"]);
      // An external rewrite returns the cursor to 0 with new bytes.
      writeState(1);
      writeState(0);
      // The next attempt is REFUSED. It commits nothing, so it must not refresh
      // the fingerprint the mirror is validated against.
      harness.pi.setModel = async (model) => {
        harness.setModels.push(model);
        return false;
      };
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/a"], "the retry targets the rewritten disk cursor");
      // Now the durable write works: the rewritten file's cursor 0 wins and a
      // is applied again — b would mean the stale mirror survived the refusal.
      failing = false;
      harness.pi.setModel = async (model) => {
        harness.setModels.push(model);
      };
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.equal(appliedIds(harness.setModels).at(-1), "p/a");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 1);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shares the degraded mirror with a same-role spawn that falls back", async () => {
    const { dir, file } = tmpStateFile();
    const restore = patchRename(() => () => {
      const err = new Error("denied");
      err.code = "EACCES";
      throw err;
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { slow: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
        mainSessionRole: "slow",
      });
      const models = makeModels(["p/a", "p/b"]);
      // main: accept a, durable write fails -> counter mirrors 1.
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      // same-role spawn: its persisted attempt also fails and falls back to the
      // in-memory counter, which it advances to 0 and reports b.
      const spawn = await harness.handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models));
      assert.equal(headOf(spawn?.model), "p/b");
      // Next startup must follow that shared counter back to a. A private copy
      // of the mirror would still read 1 here and repeat b.
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/a"]);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let another state file's picks move a degraded file's cursor", async () => {
    const a = tmpStateFile();
    const b = tmpStateFile();
    const writeCursor = (file, cursor) =>
      fs.writeFileSync(
        file,
        `${JSON.stringify({ version: 2, counters: { default: cursor } }, null, 2)}\n`,
        "utf8",
      );
    writeCursor(a.file, 0);
    writeCursor(b.file, 1);
    // Only file A's replacement fails; B persists normally.
    const restore = patchRename((original) => (from, to) => {
      if (String(to) === a.file) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      const pools = { default: ["p/a", "p/b", "p/c"] };
      const models = makeModels(["p/a", "p/b", "p/c"]);

      mod.default(harness.pi, { pools, persistCounters: true, stateFile: a.file });
      // A: accept a, write fails -> A's mirror points at b.
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));

      // Rebind to B: its own cursor 1 picks b and commits, moving the shared
      // role counter to 2.
      mod.configurePools({ pools, persistCounters: true, stateFile: b.file });
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));

      // Back on A, whose bytes never changed: the mirror still says b, so the
      // shared counter's 2 must not reach c.
      mod.configurePools({ pools, persistCounters: true, stateFile: a.file });
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));

      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/b", "p/b"]);
      assert.equal(JSON.parse(fs.readFileSync(b.file, "utf8")).counters.default, 2);
    } finally {
      restore();
      fs.rmSync(a.dir, { recursive: true, force: true });
      fs.rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it("recovers when the lock cannot be removed after a committed turn", async () => {
    const { dir, file } = tmpStateFile();
    const lockDir = `${file}.lock`;
    const originalRm = nodeFs.rmSync;
    let failedOnce = false;
    nodeFs.rmSync = (target, options) => {
      if (!failedOnce && String(target) === lockDir) {
        failedOnce = true;
        const err = new Error("still open");
        err.code = "EPERM";
        throw err;
      }
      return originalRm(target, options);
    };
    syncBuiltinESMExports();
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      // First turn commits, then fails to delete its own lock directory.
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.equal(failedOnce, true, "the release failure was exercised");
      const started = Date.now();
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2_000, `the next turn waited ${elapsed}ms for a lock this process owns`);
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/b"]);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 0);
    } finally {
      nodeFs.rmSync = originalRm;
      syncBuiltinESMExports();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours the degraded cursor when persistence recovers before a same-role spawn", async () => {
    const { dir, file } = tmpStateFile();
    let failing = true;
    const restore = patchRename((original) => (from, to) => {
      if (failing) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { slow: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
        mainSessionRole: "slow",
      });
      const models = makeModels(["p/a", "p/b"]);
      // Accept a while the durable write fails: the mark mirrors b.
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      // Persistence recovers BEFORE the spawn: the spawn's own write will
      // succeed, so it must still read the mirror rather than the stale file.
      failing = false;
      const spawn = await harness.handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models));
      assert.equal(headOf(spawn?.model), "p/b");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 0);
      assert.equal(fs.existsSync(`${file}.lock`), false, "the lock is released");
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances the degraded mirror when a startup falls back on a read failure", async () => {
    const { dir, file } = tmpStateFile();
    fs.writeFileSync(file, `${JSON.stringify({ version: 2, counters: { default: 0 } }, null, 2)}\n`, "utf8");
    let renameFails = true;
    let readFails = false;
    const restoreRename = patchRename((original) => (from, to) => {
      if (renameFails) {
        const err = new Error("denied");
        err.code = "EACCES";
        throw err;
      }
      return original(from, to);
    });
    const originalRead = nodeFs.readFileSync;
    nodeFs.readFileSync = (target, options) => {
      if (readFails && String(target) === file) {
        const err = new Error("io error");
        err.code = "EIO";
        throw err;
      }
      return originalRead(target, options);
    };
    syncBuiltinESMExports();
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      const models = makeModels(["p/a", "p/b"]);
      // 1: accepted a, durable write fails -> mirror points at b.
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      // 2: the state read fails, so this startup falls back to memory and
      // applies b; the mirror must follow it to a.
      readFails = true;
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      // 3: persistence recovers; the unchanged file still matches the mark, so
      // the mirrored a is next — not b again.
      readFails = false;
      renameFails = false;
      await handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      assert.deepEqual(appliedIds(harness.setModels), ["p/a", "p/b", "p/a"]);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 1);
    } finally {
      restoreRename();
      nodeFs.readFileSync = originalRead;
      syncBuiltinESMExports();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes the v1 backup without following an existing symlink", async (t) => {
    const { dir, file } = tmpStateFile();
    const victim = path.join(dir, "victim.txt");
    const backup = `${file}.v1.bak`;
    fs.writeFileSync(file, JSON.stringify({ version: 1, counters: { slow: 7 } }), "utf8");
    fs.writeFileSync(victim, "do not overwrite me", "utf8");
    try {
      fs.symlinkSync(victim, backup);
    } catch {
      t.skip("this platform/filesystem does not allow creating symlinks");
      return;
    }
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.equal(fs.readFileSync(victim, "utf8"), "do not overwrite me", "the symlink target is untouched");
      assert.equal(fs.lstatSync(backup).isSymbolicLink(), false, "the backup entry is a regular file now");
      assert.equal(JSON.parse(fs.readFileSync(backup, "utf8")).version, 1, "the backup holds the v1 bytes");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a queued spawn writing to the state file it was queued for", async () => {
    const first = tmpStateFile();
    const second = tmpStateFile();
    const gate = deferred();
    try {
      const harness = makeHarness();
      harness.pi.setModel = async () => {
        await gate.promise;
        return undefined;
      };
      mod.default(harness.pi, {
        pools: { slow: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: first.file,
        mainSessionRole: "slow",
      });
      const models = makeModels(["p/a", "p/b"]);
      const startup = handleSessionStart(harness, mainCtx(models, [], freshHeader()));
      const spawn = harness.handlers.before_subagent_spawn(SLOW_EVENT_FOR_SLOW, subCtx(models));
      // A factory rebind lands while the spawn waits in the role queue.
      mod.configurePools({
        pools: { slow: ["p/x", "p/y", "p/z"] },
        persistCounters: true,
        stateFile: second.file,
      });
      gate.resolve();
      await startup;
      const result = await spawn;
      assert.equal(headOf(result?.model), "p/b", "the queued spawn still uses the pool it captured");
      // The startup committed the slot b (cursor 1); the queued spawn then
      // consumed b and wrapped its captured file to 0. Had it followed the
      // rebind, this file would still read 1 and the new file would exist.
      assert.equal(JSON.parse(fs.readFileSync(first.file, "utf8")).counters.slow, 0);
      assert.equal(fs.existsSync(second.file), false, "the rebound state file is not touched by the old pool");
    } finally {
      fs.rmSync(first.dir, { recursive: true, force: true });
      fs.rmSync(second.dir, { recursive: true, force: true });
    }
  });

  it("retries a transient rename and commits once from the same temp file", async () => {
    const { dir, file } = tmpStateFile();
    const temps = [];
    let attempts = 0;
    const restore = patchRename((original) => (from, to) => {
      attempts += 1;
      temps.push(String(from));
      if (attempts <= 2) {
        const err = new Error("sharing violation");
        err.code = "EPERM";
        throw err;
      }
      return original(from, to);
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      if (process.platform === "win32") {
        assert.equal(attempts, 3, "two transient failures then a commit");
        assert.equal(new Set(temps).size, 1, "every retry renames the same temp file");
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.default, 1);
      } else {
        // The retry is Windows-only by design: elsewhere the first failure is final.
        assert.equal(attempts, 1);
        assert.deepEqual(mod.getCounters(), { default: 1 });
      }
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the live bytes untouched and removes the temp when the rename never succeeds", async () => {
    const { dir, file } = tmpStateFile();
    const before = `${JSON.stringify({ version: 2, counters: { default: 0 } }, null, 2)}\n`;
    fs.writeFileSync(file, before);
    let attempts = 0;
    const restore = patchRename(() => () => {
      attempts += 1;
      const err = new Error("still locked");
      err.code = "EPERM";
      throw err;
    });
    try {
      const harness = makeHarness();
      mod.default(harness.pi, {
        pools: { default: ["p/a", "p/b"] },
        persistCounters: true,
        stateFile: file,
      });
      await handleSessionStart(harness, mainCtx(makeModels(["p/a", "p/b"]), [], freshHeader()));
      assert.equal(fs.readFileSync(file, "utf8"), before, "the live state file is never replaced or unlinked");
      assert.deepEqual(
        fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
        [],
        "the temp file is cleaned up",
      );
      assert.equal(harness.setModels.length, 1);
      if (process.platform === "win32") assert.equal(attempts, 5, "one attempt plus the four bounded retries");
      else assert.equal(attempts, 1);
    } finally {
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
