import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mod = await import("../dist/index.js");

function makeModels(available, current) {
  // available: string[] like "prov/model"; `current` models the host's active
  // model (a `{ provider, id }` object, a "provider/id" string, or undefined).
  const parsed = available.map((s) => {
    const i = s.indexOf("/");
    return i >= 0
      ? { provider: s.slice(0, i), id: s.slice(i + 1) }
      : { provider: "", id: s };
  });
  const currentModel = () => {
    const value = typeof current === "function" ? current() : current;
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return { ...value };
    const i = value.indexOf("/");
    return i >= 0
      ? { provider: value.slice(0, i), id: value.slice(i + 1) }
      : { provider: "", id: value };
  };
  // The host resolves `provider/id:level` to the same model with a thinking
  // level, so a pool entry carrying one still matches the registry list.
  const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "inherit"]);
  const match = (selector) =>
    parsed.find((m) => `${m.provider}/${m.id}` === selector || m.id === selector);
  return {
    list: () => parsed.map((m) => ({ ...m })),
    current: currentModel,
    resolve: (spec) => {
      const t = String(spec).trim();
      // role aliases do not resolve here; only concrete selectors do.
      if (t.startsWith("@")) return undefined;
      const found = match(t);
      if (found) return { ...found };
      const colon = t.lastIndexOf(":");
      if (colon === -1 || !THINKING.has(t.slice(colon + 1))) return undefined;
      const base = match(t.slice(0, colon));
      return base ? { ...base } : undefined;
    },
  };
}

function makeHarness() {
  const handlers = {};
  const logs = [];
  const notified = [];
  const setModels = [];
  const providers = [];
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    setModel: async (m) => {
      setModels.push(m);
    },
    registerProvider: (name, config) => {
      providers.push([name, config]);
    },
    unregisterProvider: (name) => {
      providers.push([name, undefined]);
    },
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      debug: (...a) => logs.push(["debug", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
  };
  return { handlers, logs, notified, setModels, providers, pi };
}

// The host applies a resolved `Model`, so assertions compare `provider/id`
// identities; the original values in `setModels` are kept for shape checks.
function appliedIds(setModels) {
  return setModels.map((m) =>
    m !== null && typeof m === "object" ? `${m.provider}/${m.id}` : String(m),
  );
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

describe("pool round robin", () => {
  it("cycles same pool through slow[0..2] then wraps", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] } });
    const models = makeModels(["p/a", "p/b", "p/c"]);
    const picks = [];
    for (let i = 0; i < 4; i++) {
      const r = await handlers.before_subagent_spawn(
        { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] },
        subCtx(models),
      );
      assert.equal(r.model.length, 3, "every eligible member is a fallback");
      const picked = r.model[0];
      picks.push(picked);
      assert.deepEqual(
        [...r.model].sort(),
        ["p/a", "p/b", "p/c"],
        "the pool's members are the retry chain, starting at the pick",
      );
      assert.match(r.note, new RegExp(`^pool/slow\\[[1-3]/3\\]: ${picked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    }
    assert.deepEqual(picks, ["p/a", "p/b", "p/c", "p/a"]);
  });

  it("shares one counter across different agents on the same pool", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const models = makeModels(["p/a", "p/b"]);
    const ctx = subCtx(models);
    const r1 = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] }, ctx);
    const r2 = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "scout", invocationKind: "eval", patterns: ["pool/slow"] }, ctx);
    const r3 = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: ["pool/slow"] }, ctx);
    assert.equal(r1.model[0], "p/a");
    assert.equal(r2.model[0], "p/b"); // agent name irrelevant
    assert.equal(r3.model[0], "p/a");
  });

  it("treats '@slow' and 'slow' pool keys identically", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { "@slow": ["p/a", "p/b"] } });
    assert.deepEqual(Object.keys(mod.getPools()), ["slow"]);
    const r = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] },
      subCtx(makeModels(["p/a", "p/b"])));
    assert.equal(r.model[0], "p/a");
  });

  it("ignores wrapper option keys in a flat config", () => {
    const { pi } = makeHarness();
    // A flat map keeps its option keys at the top level; only real pools remain.
    mod.default(pi, { slow: ["p/a"], strict: true, persistCounters: false, mainSessionRole: "default" });
    assert.deepEqual(Object.keys(mod.getPools()), ["slow"]);
  });

  it("leaves unconfigured pools and other selectors untouched", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    const models = makeModels(["p/a"]);
    const r1 = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/fast"] },
      subCtx(models));
    assert.equal(r1, undefined);
    const r2 = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["@slow"] },
      subCtx(models));
    assert.equal(r2, undefined);
    assert.deepEqual(mod.getCounters(), {});
  });

  it("preserves explicit per-dispatch pins", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const r = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["p/pinned"] },
      subCtx(makeModels(["p/a", "p/b"])));
    assert.equal(r, undefined);
    assert.deepEqual(mod.getCounters(), {});
  });

  it("filters unauthenticated entries and fails open when the pool empties", async () => {
    const { pi, handlers, logs } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/missing"] } });
    const models = makeModels(["p/a"]); // p/missing not authenticated
    const r1 = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] },
      subCtx(models));
    assert.deepEqual(r1.model, ["p/a"]); // filtered, single survivor
    mod.resetCounters();
    mod.configurePools({ pools: { slow: ["p/gone"] } });
    const r2 = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] },
      subCtx(models));
    assert.equal(r2, undefined);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("empty pool/slow")));
  });

  it("keeps a stable phase when availability changes mid-cycle", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] } });
    const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] };
    let authenticated = ["p/a", "p/b"]; // p/c not authenticated yet
    const pick = async () => (await handlers.before_subagent_spawn(ev, subCtx(makeModels(authenticated)))).model[0];

    const picks = [await pick(), await pick(), await pick()];
    authenticated = ["p/a", "p/b", "p/c"]; // p/c authenticates mid-cycle
    picks.push(await pick(), await pick(), await pick());

    // Modding a filtered list re-phased here and emitted "…, p/a, p/a, p/b, p/c";
    // indexing the configured pool keeps the phase: no duplicate at the swap.
    assert.deepEqual(picks, ["p/a", "p/b", "p/a", "p/b", "p/c", "p/a"]);
    assert.ok(mod.getCounters().slow < 3, "cursor stays an index into the configured pool");
  });

  it("blocks empty pools only under strict policy", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/gone"] }, strict: ["slow"] });
    const r = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] },
      subCtx(makeModels(["p/a"])));
    assert.deepEqual(r, { block: true, reason: "model-pool: no authenticated model available in pool/slow" });
  });

  it("resetCounters mirrors an OMP restart", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const models = makeModels(["p/a", "p/b"]);
    const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] };
    assert.equal((await handlers.before_subagent_spawn(ev, subCtx(models))).model[0], "p/a");
    mod.resetCounters(); // restart: in-memory counters are gone
    assert.equal((await handlers.before_subagent_spawn(ev, subCtx(models))).model[0], "p/a");
  });

  // --- regressions -----------------------------------------------------------

  it("does not reroute a spawn that merely shares a role alias with a pool name", async () => {
    // The old contract keyed pools by role, so a pool named `slow` silently
    // overrode anything spawned as @slow. Only an explicit pool/<name> selects.
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const models = makeModels(["p/a", "p/b"]);
    for (const patterns of [["@slow"], ["p/real"]]) {
      const r = await handlers.before_subagent_spawn(
        { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns },
        subCtx(models));
      assert.equal(r, undefined, `${patterns[0]} must not be rerouted by pool slow`);
    }
    assert.deepEqual(mod.getCounters(), {}, "a non-pool spawn never advances a pool cursor");
  });

  it("carries a thinking suffix onto members that lack one", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b:low"] } });
    const r = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow:high"] },
      subCtx(makeModels(["p/a", "p/b"])));
    assert.deepEqual(r.model, ["p/a:high", "p/b:low"]);
  });

  it("lists the pick first, eligible members next, then the spawn's own fallbacks", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b", "p/c"] } });
    const models = makeModels(["p/a", "p/c"]); // p/b is not authenticated
    const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow", "p/extra"] };
    const first = await handlers.before_subagent_spawn(ev, subCtx(models));
    assert.deepEqual(first.model, ["p/a", "p/c", "p/extra"]);
    const second = await handlers.before_subagent_spawn(ev, subCtx(models));
    assert.deepEqual(second.model, ["p/c", "p/a", "p/extra"]);
  });
});

describe("main-session rotation", () => {
  it("advances the default pool once per main session_start, ignores subs", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"], default: ["p/x", "p/y"] } });
    const models = makeModels(["p/a", "p/b", "p/x", "p/y"], "pool/default");
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
    // Subagent pool cycling is unaffected apart from shared counters on overlap.
    const r = await handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] },
      subCtx(models),
    );
    assert.equal(r.model[0], "p/a");
  });

  it("never rotates a main session whose model is not pool/<name>", async () => {
    // The pool only applies where its model was selected: a real model (or a
    // role alias) is left exactly as the host set it.
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    for (const current of ["p/real", ""]) {
      const models = makeModels(["p/x", "p/y"], current);
      await handlers.session_start({ type: "session_start" }, mainCtx(models, [], freshHeader()));
    }
    assert.deepEqual(setModels, []);
    assert.deepEqual(mod.getCounters(), {}, "no cursor moves for an unselected pool");
  });

  it("does nothing when the selected pool is unconfigured", async () => {
    const { pi, handlers, setModels, notified } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    const ctx = mainCtx(makeModels(["p/a"], "pool/missing"), [], freshHeader(), notified);
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.deepEqual(setModels, []);
    assert.ok(notified.some(([m, t]) => t === "warning" && m.includes("pool/missing")));
  });

  it("does not rotate a loaded/resumed main session", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const resumed = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [
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
    const fresh = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [
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
    const fresh = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [
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
      makeModels(["p/x", "p/y"], "pool/default"),
      [{ type: "session_init", id: "e1" }, { type: "model_change", model: "openai/gpt-5.2", id: "e2" }],
      loadedHeader()
    );
    await handlers.session_start({ type: "session_start" }, resumed);
    assert.deepEqual(setModels, [], "a restored model is never overwritten");
  });

  it("rotates a session whose header was written by this process", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const fresh = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [{ type: "session_init", id: "e1" }], freshHeader());
    await handlers.session_start({ type: "session_start" }, fresh);
    assert.deepEqual(appliedIds(setModels), ["p/x"], "the startup metadata a new session carries is not a load");
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
      const ctx = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [{ type: "session_init", id: "e1" }], freshHeader());
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
    const ctx = mainCtx(makeModels(["p/x", "p/y"], "pool/default"));
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
    const ctx = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [{ type: "session_init", id: "e1" }], { timestamp: "not-a-date" });
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.deepEqual(setModels, [], "an unparseable header is unknown, not new");
  });

  it("does not rotate when the host cannot report session novelty", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    await handlers.session_start(
      { type: "session_start" },
      {
        agent: { kind: "main", name: "main", id: "Main" },
        models: makeModels(["p/x", "p/y"], "pool/default"),
        ui: { notify: () => {} },
      },
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
    const ctx = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [{ type: "session_init" }], freshHeader(), notified);
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
    const ctx = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [{ type: "session_init" }], freshHeader(), notified);
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("host refused")));
    assert.ok(!logs.some(([, m]) => m.includes("main session applied")), "a refusal is not a rotation");
    assert.ok(!notified.some(([, t]) => t === "info"), "a refusal is not toasted as a success");
  });

  it("does not claim a rotation when the registry stops resolving the pick between choose and apply", async () => {
    const { pi, handlers, logs } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    const ctx = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [{ type: "session_init" }], freshHeader());
    // Filtering the pool lists the registry and then resolves each entry; the
    // lookup that fails must be the *apply-time* one, after availability was
    // established. Failing every resolve instead would never reach that branch,
    // because an unresolvable pool is empty and returns early.
    const real = ctx.models.resolve.bind(ctx.models);
    let pendingAfterList = null;
    ctx.models.list = () => {
      pendingAfterList = 2;
      return [{ provider: "p", id: "x" }, { provider: "p", id: "y" }];
    };
    ctx.models.resolve = (spec) => {
      if (pendingAfterList === null) return real(spec); // provider sync: before any list()
      if (pendingAfterList > 0) {
        pendingAfterList -= 1;
        return real(spec);
      }
      return null; // the registry stopped resolving between choose and apply
    };
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("could not resolve")));
    assert.ok(!logs.some(([, m]) => m.includes("main session applied")));
  });

  it("tolerates a host that reports null instead of undefined, without claiming success", async () => {
    const { pi, handlers, logs, notified } = makeHarness();
    mod.default(pi, { pools: { default: ["p/x", "p/y"] } });
    let applied = false;
    const ctx = mainCtx(
      makeModels(["p/x", "p/y"], () => (applied ? null : "pool/default")),
      [{ type: "session_init" }],
      freshHeader(),
      notified,
    );
    // `current()` returning null after a successful apply must not throw, and it
    // is not evidence of success either: the host never confirmed the model, so
    // the outcome is reported as unconfirmed rather than as a completed rotation.
    pi.setModel = async () => {
      applied = true;
    };
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
    let applied = false;
    const ctx = mainCtx(
      makeModels(["p/x", "p/y"], () => (applied ? "other/model" : "pool/default")),
      [{ type: "session_init" }],
      freshHeader(),
    );
    pi.setModel = async () => {
      applied = true;
    };
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
    const ctx = mainCtx(makeModels(["p/x", "p/y"], "pool/default"), [{ type: "session_init" }], freshHeader());
    await handlers.session_start({ type: "session_start" }, ctx);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("session_start error")));
  });
});

describe("pool provider registration", () => {
  it("registers the provider `pool` with one model per pool name", () => {
    const { pi, providers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"], fast: ["p/c"] } });
    const registrations = providers.filter(([name]) => name === "pool").map(([, cfg]) => cfg);
    assert.equal(registrations.length, 1, "one provider registration for the whole extension");
    const config = registrations[0];
    assert.equal(config.api, "model-pool");
    assert.equal(typeof config.streamSimple, "function", "the provider forwards requests to a member");
    assert.deepEqual(
      config.models.map((m) => m.id),
      ["fast", "slow"],
      "each pool is selectable as pool/<name>",
    );
  });

  it("does not register a provider when the host cannot", () => {
    const { pi, providers, logs } = makeHarness();
    delete pi.registerProvider;
    mod.default(pi, { pools: { slow: ["p/a"] } });
    assert.deepEqual(providers, []);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("cannot register providers")));
  });
});

describe("cross-process counter persistence (opt-in)", () => {
  const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] };

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
        seen.push(r.model[0]);
      }
      assert.deepEqual(seen, ["p/a", "p/b", "p/c", "p/a"]);
      // The cursor is stored modulo the pool length (3), so four picks land on 1.
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no state file when persistence is off", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, stateFile: file });
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(r.model[0], "p/a");
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
      assert.equal(r.model[0], "p/a"); // in-memory fallback still routes
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("persisted counter")));
      assert.equal(fs.readFileSync(file, "utf8"), "{ not json"); // untouched for the operator
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps in-process picks distinct (real cross-process contention is covered in cross-process.test.mjs)", async () => {
    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const models = makeModels(["p/a", "p/b"]);
      const [r1, r2] = await Promise.all([
        handlers.before_subagent_spawn(ev, subCtx(models)),
        handlers.before_subagent_spawn(ev, subCtx(models)),
      ]);
      assert.deepEqual([r1.model[0], r2.model[0]].sort(), ["p/a", "p/b"]);
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
      const models = makeModels(["p/x", "p/y"], "pool/default");
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
      assert.equal(r.model[0], "p/a"); // falls back to in-memory, ignores the foreign cursor
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
      assert.equal(first.model[0], "p/a"); // fresh cursor, not index 1 of a reinterpreted count
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("version-1 state file")));
      // The old file is preserved for inspection...
      assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.v1.bak`, "utf8")), { version: 1, counters: { slow: 4 } });
      // ...and the live file is now v2, so persistence has not been left dead.
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 2, counters: { slow: 1 } });

      // The proof that it resumed: the next pick continues from the replaced
      // cursor instead of restarting, which a merely-rejected file could not.
      const second = await handlers.before_subagent_spawn(ev, avail);
      assert.equal(second.model[0], "p/b");
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
      assert.equal(r.model[0], "p/a");
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
      assert.equal(r.model[0], "p/a");
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
      assert.equal(r.model[0], "p/a");
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
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(r.model[0], "p/a");
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
  const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", patterns: ["pool/slow"] };

  it("hard-blocks a pool when strict is the boolean true", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/gone"] }, strict: true });
    const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/other"])));
    assert.deepEqual(r, { block: true, reason: "model-pool: no authenticated model available in pool/slow" });
  });

  it("does not hard-block when the model registry is unreadable", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] }, strict: ["slow"] });
    const noRegistry = { agent: { kind: "sub" }, models: undefined, ui: { notify: () => {} } };
    assert.equal(await handlers.before_subagent_spawn(ev, noRegistry), undefined);
  });

  it("does not hard-block when the registry read throws", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] }, strict: ["slow"] });
    const throwing = {
      agent: { kind: "sub" },
      models: { list: () => { throw new Error("registry down"); }, current: () => undefined, resolve: () => undefined },
      ui: { notify: () => {} },
    };
    assert.equal(await handlers.before_subagent_spawn(ev, throwing), undefined);
  });

  it("still hard-blocks when the registry answers that nothing is authenticated", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/gone"] }, strict: ["slow"] });
    const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/other"])));
    assert.deepEqual(r, { block: true, reason: "model-pool: no authenticated model available in pool/slow" });
  });
});
