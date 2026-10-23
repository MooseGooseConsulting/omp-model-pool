import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist/index.js");

function makeModels(available) {
  // available: string[] like "prov/model"
  const parsed = available.map((s) => {
    const i = s.indexOf("/");
    return i >= 0
      ? { provider: s.slice(0, i), id: s.slice(i + 1) }
      : { provider: "", id: s };
  });
  return {
    list: () => parsed.map((m) => ({ ...m })),
    current: () => undefined,
    resolve: (spec) => {
      const t = String(spec).trim();
      // role aliases do not resolve here; only concrete selectors do.
      if (t.startsWith("@")) return undefined;
      const found = parsed.find(
        (m) => `${m.provider}/${m.id}` === t || m.id === t,
      );
      return found ? { ...found } : undefined;
    },
  };
}

function makeHarness() {
  const handlers = {};
  const logs = [];
  const notified = [];
  const setModels = [];
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    setModel: async (m) => {
      setModels.push(m);
    },
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      debug: (...a) => logs.push(["debug", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
  };
  return { handlers, logs, notified, setModels, pi };
}

function subCtx(models, agentKind = "sub") {
  return {
    agent: { kind: agentKind, name: "task", id: "1" },
    models,
    ui: { notify: () => {} },
  };
}

beforeEach(() => {
  mod.resetCounters();
  delete process.env.OMP_MODEL_POOLS_JSON;
  delete process.env.OMP_MODEL_POOL_CONFIG;
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
      picks.push(r.model);
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
    assert.equal(r1.model, "p/a");
    assert.equal(r2.model, "p/b"); // agent name irrelevant
    assert.equal(r3.model, "p/a");
  });

  it("treats '@slow' and 'slow' pool keys identically", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { "@slow": ["p/a", "p/b"] } });
    assert.deepEqual(Object.keys(mod.getPools()), ["slow"]);
    const models = makeModels(["p/a", "p/b"]);
    const r = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
      subCtx(models));
    assert.equal(r.model, "p/a");
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
    assert.equal(r1.model, "p/a"); // filtered, single survivor cycles
    mod.resetCounters();
    mod.configurePools({ pools: { slow: ["p/gone"] } });
    const r2 = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
      subCtx(models));
    assert.equal(r2, undefined);
    assert.ok(logs.some(([l, m]) => l === "warn" && m.includes("empty pool")));
  });

  it("blocks empty pools only under strict policy", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/gone"] }, strict: ["slow"] });
    const r = handlers.before_subagent_spawn(
      { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] },
      subCtx(makeModels(["p/a"])));
    assert.deepEqual(r, { block: true, reason: "model-pool: no authenticated model available for role @slow" });
  });

  it("resetCounters mirrors an OMP restart", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"] } });
    const models = makeModels(["p/a", "p/b"]);
    const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] };
    assert.equal(handlers.before_subagent_spawn(ev, subCtx(models)).model, "p/a");
    mod.resetCounters(); // restart: in-memory counters are gone
    assert.equal(handlers.before_subagent_spawn(ev, subCtx(models)).model, "p/a");
  });
});

describe("main-session rotation", () => {
  it("advances the default pool once per main session_start, ignores subs", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/b"], default: ["p/x", "p/y"] } });
    const models = makeModels(["p/a", "p/b", "p/x", "p/y"]);
    const main = { agent: { kind: "main", name: "main", id: "Main" }, models, ui: { notify: () => {} } };
    await handlers.session_start({ type: "session_start" }, main);
    await handlers.session_start({ type: "session_start" }, main);
    await handlers.session_start({ type: "session_start" }, main);
    assert.deepEqual(setModels, ["p/x", "p/y", "p/x"]);
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
    assert.equal(r.model, "p/a");
  });

  it("does nothing when the main role pool is unconfigured", async () => {
    const { pi, handlers, setModels } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    await handlers.session_start(
      { type: "session_start" },
      { agent: { kind: "main", name: "main", id: "Main" }, models: makeModels(["p/a"]), ui: { notify: () => {} } },
    );
    assert.deepEqual(setModels, []);
  });
});
