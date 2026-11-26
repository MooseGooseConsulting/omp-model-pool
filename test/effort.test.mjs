// Explicit thinking-level application on the main-session rotation path.
//
// These cases exist because the effort request is the one part of startup
// rotation that can silently no-op: the model is accepted, the cursor moves,
// and the thinking level is simply never applied. Every assertion below reads
// the host call order or a user-visible warning, never the extension's own
// decision variables.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mod = await import("../dist/index.js");

/** `provider/id` -> `{ provider, id }`, with a settable active model. */
function makeModels(rows, currentId) {
  let current = currentId === undefined ? undefined : byIdentity(rows, currentId);
  return {
    list: () => rows.map((m) => ({ ...m })),
    current: () => (current === undefined ? undefined : { ...current }),
    setCurrent: (identity) => {
      current = identity === undefined ? undefined : byIdentity(rows, identity);
    },
    /** Resolve the literal id first, then a comma alternative, then a suffixed form. */
    resolve: (spec) => {
      const text = String(spec).trim();
      const exact = byIdentity(rows, text);
      if (exact !== undefined) return { ...exact };
      if (text.includes(",")) {
        for (const part of text.split(",")) {
          const hit = byIdentity(rows, part.trim());
          if (hit !== undefined) return { ...hit };
        }
        return undefined;
      }
      // Strip an effort suffix and/or upstream route the way a host would.
      for (const pattern of [
        /^(.+?):[A-Za-z][A-Za-z0-9]*@[A-Za-z0-9._\/-]+$/,
        /^(.+?)@[A-Za-z0-9._\/-]+:[A-Za-z][A-Za-z0-9]*$/,
        /^(.+?):[A-Za-z][A-Za-z0-9]*$/,
        /^(.+?)@[A-Za-z0-9._\/-]+$/,
      ]) {
        const match = pattern.exec(text);
        if (match === null) continue;
        const hit = byIdentity(rows, match[1]);
        if (hit !== undefined) return { ...hit };
        // A comma inside the stripped form is not supported here on purpose.
      }
      if (text.startsWith("@")) {
        const alias = ALIASES[text.slice(1).split(":")[0]];
        if (alias !== undefined) return { ...byIdentity(rows, alias) };
      }
      return undefined;
    },
  };
}

// Bare role aliases this file uses; each maps to a concrete `provider/id`.
const ALIASES = { fast: "p/b-high", kept: "p/b" };

function byIdentity(rows, identity) {
  const text = String(identity ?? "").trim();
  if (text.length === 0) return undefined;
  const exact = rows.find((m) => `${m.provider}/${m.id}` === text);
  if (exact !== undefined) return exact;
  const bare = rows.find((m) => m.id === text);
  if (bare !== undefined) return bare;
  const alias = ALIASES[text.replace(/^@/, "").split(":")[0]];
  return alias === undefined ? undefined : rows.find((m) => `${m.provider}/${m.id}` === alias);
}

function makeHarness({ withSetter = true, setterThrows = false, refuse = false, currentAfter } = {}) {
  const calls = [];
  const logs = [];
  const notified = [];
  const handlers = {};
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    setModel: async (model) => {
      calls.push(`setModel:${model.provider}/${model.id}`);
      return refuse === false ? undefined : false;
    },
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      debug: (...a) => logs.push(["debug", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
  };
  if (withSetter) {
    pi.setThinkingLevel = (level) => {
      calls.push(`setThinkingLevel:${level}`);
      if (setterThrows) throw new Error("setter exploded");
    };
  }
  return { pi, handlers, calls, logs, notified, currentAfter };
}

function freshMainCtx(models, notified) {
  return {
    agent: { kind: "main", name: "main", id: "Main" },
    models,
    ui: { notify: (message, type) => notified.push([message, type]) },
    sessionManager: {
      getEntries: () => [],
      getHeader: () => ({ type: "session", id: "s", timestamp: new Date().toISOString() }),
    },
  };
}

/**
 * Install one fresh factory with a `default` pool of `slots`, run exactly one
 * main-session startup, and report the host calls plus the resulting cursor.
 */
async function rotate(slots, options = {}) {
  mod.resetCounters();
  const harness = makeHarness(options);
  mod.default(harness.pi, {
    pools: { default: slots },
    ...(options.persistCounters === true
      ? { persistCounters: true, stateFile: options.stateFile }
      : {}),
  });
  const rows = options.rows;
  const models = makeModels(rows, options.startModel);
  // A real host reports the model it just accepted. Without this the
  // extension correctly sees a mismatch, so nothing would be consumed and no
  // effort request would be attempted — every case would pass vacuously.
  const baseSetModel = harness.pi.setModel;
  harness.pi.setModel = async (model) => {
    const applied = await baseSetModel(model);
    if (applied !== false) {
      models.setCurrent(options.currentAfter ?? `${model.provider}/${model.id}`);
    }
    return applied;
  };
  const ctx = freshMainCtx(models, harness.notified);
  await harness.handlers.session_start({ type: "session_start" }, ctx);
  return { ...harness, cursor: mod.getCounters().default ?? 0, logs: harness.logs };
}

const warnText = (logs) => logs.filter(([level]) => level === "warn").map(([, m]) => m).join("\n");

beforeEach(() => {
  mod.resetCounters();
  delete process.env.OMP_MODEL_POOLS_JSON;
  delete process.env.OMP_MODEL_POOL_CONFIG;
});

// Two concrete models per case; `b` and `a` are the pool members.
const rows = [
  { provider: "p", id: "a" },
  { provider: "p", id: "b" },
  { provider: "p", id: "b-high" },
  { provider: "p", id: "other" },
];

describe("effort: call order and accepted spellings", () => {
  it("applies the thinking level after the model is accepted", async () => {
    const { calls } = await rotate(["p/b:high"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  for (const [slot, level] of [
    ["p/b:high", "high"],
    ["p/b:max", "max"],
    ["p/b:low", "low"],
  ]) {
    it(`applies the concrete level for ${slot}`, async () => {
      const { calls } = await rotate([slot], { rows, startModel: "p/a" });
      assert.deepEqual(calls, ["setModel:p/b", `setThinkingLevel:${level}`]);
    });
  }

  it("recognises a unique case-sensitive prefix of at least two characters", async () => {
    const { calls } = await rotate(["p/b:hi"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  it("recognises a unique medium prefix without confusing it with max", async () => {
    const { calls } = await rotate(["p/b:me"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:medium"]);
  });

  it("applies an alias suffix even when the resolved id already ends in that level", async () => {
    const { calls } = await rotate(["@fast:high"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b-high", "setThinkingLevel:high"]);
  });

  it("parses the level before an upstream route", async () => {
    const { calls } = await rotate(["p/b:high@upstream"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  it("parses the level after an upstream route", async () => {
    const { calls } = await rotate(["p/b@upstream:high"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  it("leaves effort alone for a literal id that already ends in the level", async () => {
    // The registry resolves p/b:high to the literal model whose id is `b-high`
    // only for this case, so the suffix is part of the id, not a request.
    const literalRows = [{ provider: "p", id: "b:high" }];
    const { calls } = await rotate(["p/b:high"], { rows: literalRows, startModel: "p/b:high" });
    assert.deepEqual(calls, ["setModel:p/b:high"]);
  });
});

describe("effort: cases that must set nothing", () => {
  it("ignores a losing comma alternative whose identity differs from the applied model", async () => {
    const { calls } = await rotate(["p/other:max,p/b"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b"]);
  });

  it("sets no effort when the selector carries no suffix", async () => {
    const { calls } = await rotate(["p/b"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b"]);
  });

  it("sets no effort when the host refuses the model", async () => {
    const { calls, cursor } = await rotate(["p/b:high"], { rows, startModel: "p/a", refuse: true });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 0, "a refusal consumes no slot");
  });

  it("sets no effort when the host reports a different active model", async () => {
    const { calls, cursor } = await rotate(["p/b:high"], {
      rows,
      startModel: "p/a",
      currentAfter: "p/other",
    });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 0, "a mismatch consumes no slot");
  });
});

describe("effort: degraded hosts still consume an accepted model", () => {
  it("warns and keeps the accepted model when the host exposes no setter", async () => {
    const { calls, cursor, logs } = await rotate(["p/b:high", "p/a"], {
      rows,
      startModel: "p/a",
      withSetter: false,
    });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 1, "the accepted model is consumed");
    assert.match(warnText(logs), /no setThinkingLevel/i);
  });

  it("warns and keeps the accepted model when the setter throws", async () => {
    const { cursor, logs } = await rotate(["p/b:high", "p/a"], {
      rows,
      startModel: "p/a",
      setterThrows: true,
    });
    assert.equal(cursor, 1, "a throwing setter does not undo the cursor");
    assert.match(warnText(logs), /thinking level high was not applied|setter threw/i);
  });

  it("warns that :auto cannot be selected and keeps the model default", async () => {
    const { calls, cursor, logs } = await rotate(["p/b:auto", "p/a"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 1, "an explicit :auto still consumes the accepted model");
    assert.match(warnText(logs), /auto/i);
  });
});

describe("effort: durable cursor agreement", () => {
  it("writes the accepted cursor to the state file once the effort is requested", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-effort-"));
    const stateFile = path.join(dir, "state.json");
    try {
      const { calls } = await rotate(["p/b:high", "p/a"], {
        rows,
        startModel: "p/a",
        persistCounters: true,
        stateFile,
      });
      assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
      const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.equal(persisted.counters.default, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("effort: no request is invented for manual picks or subagents", () => {
  it("passes a suffixed subagent selector through untouched and sets no level", async () => {
    mod.resetCounters();
    const harness = makeHarness();
    mod.default(harness.pi, { pools: { slow: ["p/b:high", "p/a"] } });
    const models = makeModels(rows);
    const result = await harness.handlers.before_subagent_spawn(
      {
        type: "before_subagent_spawn",
        agent: "reviewer",
        invocationKind: "task",
        modelRole: "@slow",
        patterns: ["@slow"],
      },
      { agent: { kind: "sub", name: "task", id: "1" }, models, ui: { notify: () => {} } },
    );
    assert.equal(result?.model, "p/b:high", "the raw selector reaches the host unchanged");
    assert.deepEqual(harness.calls, [], "a subagent spawn never drives the main-session setter");
  });
});
