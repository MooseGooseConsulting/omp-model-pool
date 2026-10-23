import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
        seen.push(r.model);
      }
      assert.deepEqual(seen, ["p/a", "p/b", "p/c", "p/a"]);
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(state.counters.slow, 4);
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
      assert.equal(r.model, "p/a"); // sync result, not a promise
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
      assert.equal(r.model, "p/a"); // in-memory fallback still routes
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("persisted counter")));
      assert.equal(fs.readFileSync(file, "utf8"), "{ not json"); // untouched for the operator
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes parallel picks through the lock (no duplicate slot)", async () => {    const { dir, file } = tmpStateFile();
    try {
      const { pi, handlers } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const models = makeModels(["p/a", "p/b"]);
      const [r1, r2] = await Promise.all([
        handlers.before_subagent_spawn(ev, subCtx(models)),
        handlers.before_subagent_spawn(ev, subCtx(models)),
      ]);
      assert.deepEqual([r1.model, r2.model].sort(), ["p/a", "p/b"]);
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(state.counters.slow, 2);
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
      const main = { agent: { kind: "main", name: "main", id: "Main" }, models, ui: { notify: () => {} } };
      mod.resetCounters();
      await handlers.session_start({ type: "session_start" }, main);
      mod.resetCounters();
      await handlers.session_start({ type: "session_start" }, main);
      assert.deepEqual(setModels, ["p/x", "p/y"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a state file from an unknown schema (fail open, file untouched)", async () => {
    const { dir, file } = tmpStateFile();
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 2, counters: { slow: 5 } }));
      const { pi, handlers, logs } = makeHarness();
      mod.default(pi, { pools: { slow: ["p/a", "p/b"] }, persistCounters: true, stateFile: file });
      const r = await handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/a", "p/b"])));
      assert.equal(r.model, "p/a"); // falls back to in-memory, ignores the foreign cursor
      assert.ok(logs.some(([level, msg]) => level === "warn" && msg.includes("persisted counter")));
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2); // not overwritten
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("state file path resolution", () => {
  it("expands a leading ~ and never returns a literal ~ path", () => {
    const p = mod.resolveStateFilePath("~/custom/state.json");
    assert.ok(path.isAbsolute(p), p);
    assert.ok(!p.includes("~"), p);
    assert.equal(p, path.resolve(path.join(os.homedir(), "custom", "state.json")));
  });

  it("honors PI_CODING_AGENT_DIR as the base for relative and default paths", () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    const base = path.join(os.tmpdir(), "mmm-agent");
    process.env.PI_CODING_AGENT_DIR = base;
    try {
      assert.equal(mod.resolveStateFilePath("state.json"), path.resolve(base, "state.json"));
      assert.equal(mod.resolveStateFilePath(), path.join(path.resolve(base), "model-musical-models-state.json"));
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
});

describe("strict policy boundary", () => {
  const ev = { type: "before_subagent_spawn", agent: "reviewer", invocationKind: "task", modelRole: "@slow", patterns: ["@slow"] };

  it("does not hard-block when the model registry is unreadable", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] }, strict: ["slow"] });
    const noRegistry = { agent: { kind: "sub" }, models: undefined, ui: { notify: () => {} } };
    assert.equal(handlers.before_subagent_spawn(ev, noRegistry), undefined);
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

  it("still hard-blocks when the registry answers that nothing is authenticated", () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/gone"] }, strict: ["slow"] });
    const r = handlers.before_subagent_spawn(ev, subCtx(makeModels(["p/other"])));
    assert.deepEqual(r, { block: true, reason: "model-pool: no authenticated model available for role @slow" });
  });
});
