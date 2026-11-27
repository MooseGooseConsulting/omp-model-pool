// Explicit thinking-level application on the main-session rotation path.
//
// These cases exist because the effort request is the one part of startup
// rotation that can silently no-op: the model is accepted, the cursor moves,
// and the thinking level is simply never applied. Every assertion below reads
// the host call order or a user-visible warning, never the extension's own
// decision variables. The fake resolves a selector only by the exact spelling
// a case registered or by literal identity — it never parses one, so a
// production rewrite cannot pass through a mirror of the host's own rules.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mod = await import("../dist/index.js");

/** Literal identity lookup only: exact `provider/id`, then a bare id. Never
 * parses a suffix, a route or an alias out of the identity text. */
function byIdentity(rows, identity) {
  const text = String(identity ?? "").trim();
  if (text.length === 0) return undefined;
  const exact = rows.find((m) => `${m.provider}/${m.id}` === text);
  if (exact !== undefined) return exact;
  return rows.find((m) => m.id === text);
}

/** `provider/id` -> `{ provider, id }`, with a settable active model.
 * `exact` maps the selector spellings a case registered to the identity each
 * must resolve to; anything else resolves only as a literal identity. */
function makeModels(rows, currentId, exact = {}) {
  let current = currentId === undefined ? undefined : byIdentity(rows, currentId);
  const resolveRow = (identity) => {
    const hit = byIdentity(rows, identity);
    return hit === undefined ? undefined : { ...hit };
  };
  return {
    list: () => rows.map((m) => ({ ...m })),
    current: () => (current === undefined ? undefined : { ...current }),
    setCurrent: (identity) => {
      current = identity === undefined ? undefined : byIdentity(rows, identity);
    },
    resolve: (spec) => {
      const text = String(spec ?? "").trim();
      const mapped = exact[text];
      if (mapped !== undefined) {
        const hit = resolveRow(mapped);
        if (hit !== undefined) return hit;
      }
      return resolveRow(text);
    },
  };
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
 * `options.exact` registers the selector spellings the host is expected to
 * pass, mapped to the identity each must resolve to.
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
  const models = makeModels(rows, options.startModel, options.exact);
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

/** Effort/thinking warnings only: an unrelated registration warning must never
 * make an effort assertion brittle. */
const effortWarnText = (logs) =>
  logs
    .filter(([level, message]) => level === "warn" && /thinking|effort/i.test(message))
    .map(([, m]) => m)
    .join("\n");

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
    const { calls } = await rotate(["p/b:high"], {
      rows,
      startModel: "p/a",
      exact: { "p/b:high": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  for (const [slot, level] of [
    ["p/b:max", "max"],
    ["p/b:low", "low"],
  ]) {
    it(`applies the concrete level for ${slot}`, async () => {
      const { calls } = await rotate([slot], { rows, startModel: "p/a", exact: { [slot]: "p/b" } });
      assert.deepEqual(calls, ["setModel:p/b", `setThinkingLevel:${level}`]);
    });
  }

  it("recognises a unique case-sensitive prefix of at least two characters", async () => {
    const { calls } = await rotate(["p/b:hi"], { rows, startModel: "p/a", exact: { "p/b:hi": "p/b" } });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  it("recognises a unique medium prefix without confusing it with max", async () => {
    const { calls } = await rotate(["p/b:me"], { rows, startModel: "p/a", exact: { "p/b:me": "p/b" } });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:medium"]);
  });

  it("applies an alias suffix even when the resolved id already ends in that level", async () => {
    const { calls } = await rotate(["@fast:high"], {
      rows,
      startModel: "p/a",
      exact: { "@fast:high": "p/b-high" },
    });
    assert.deepEqual(calls, ["setModel:p/b-high", "setThinkingLevel:high"]);
  });

  it("parses the level before an upstream route", async () => {
    const { calls } = await rotate(["p/b:high@upstream"], {
      rows,
      startModel: "p/a",
      exact: { "p/b:high@upstream": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  it("parses the level after an upstream route", async () => {
    const { calls } = await rotate(["p/b@upstream:high"], {
      rows,
      startModel: "p/a",
      exact: { "p/b@upstream:high": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
  });

  it("applies the level even when the model's name ends in the level word", async () => {
    // `p/b-high:high`: the id merely ends in "high", the writer still asked for
    // high explicitly, so the request must be honoured.
    const namedRows = [{ provider: "p", id: "b-high" }];
    const { calls } = await rotate(["p/b-high:high"], {
      rows: namedRows,
      startModel: "p/b-high",
      exact: { "p/b-high:high": "p/b-high" },
    });
    assert.deepEqual(calls, ["setModel:p/b-high", "setThinkingLevel:high"]);
  });

  it("leaves effort alone when the id itself carries the colon suffix", async () => {
    // `p/b:high` resolving to a row whose id is literally `b:high` means the
    // suffix belongs to the id, not to the request.
    const literalRows = [{ provider: "p", id: "b:high" }];
    const { calls } = await rotate(["p/b:high"], {
      rows: literalRows,
      startModel: "p/b:high",
      exact: { "p/b:high": "p/b:high" },
    });
    assert.deepEqual(calls, ["setModel:p/b:high"]);
  });

  it("leaves a literal :free id untouched and sets no level", async () => {
    // `:free` is not a thinking level on any ladder: the literal id owns the
    // whole colon suffix, so no effort request and no warning is invented.
    const freeRows = [
      { provider: "p", id: "b:free" },
      { provider: "p", id: "a" },
    ];
    const { calls, cursor, logs } = await rotate(["p/b:free", "p/a"], {
      rows: freeRows,
      startModel: "p/a",
      exact: { "p/b:free": "p/b:free" },
    });
    assert.deepEqual(calls, ["setModel:p/b:free"], "the literal id is applied as-is");
    assert.equal(cursor, 1, "the accepted literal id is consumed");
    assert.equal(effortWarnText(logs), "", "no effort request and no warning is invented");
  });
});

describe("effort: cases that must set nothing", () => {
  it("applies the winning suffixed comma alternative and sets its level", async () => {
    // A comma slot is one configured entry; the second slot gives the cursor
    // somewhere to advance to. Both identities stay registered: the full
    // selector resolves the pool slot, the first alternative agrees with it.
    const { calls, cursor } = await rotate(["p/b:high,p/other", "p/a"], {
      rows,
      startModel: "p/a",
      exact: { "p/b:high,p/other": "p/b", "p/b:high": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"], "the winning alternative carries the request");
    assert.equal(cursor, 1);
  });

  it("ignores a losing comma alternative whose identity differs from the applied model", async () => {
    // The comma chain is one entry; the second slot makes the cursor advance
    // visible. Both identities stay registered: the full selector resolves the
    // applied `p/b`, the losing first alternative resolves to `p/other`.
    const { calls, cursor } = await rotate(["p/other:max,p/b", "p/a"], {
      rows,
      startModel: "p/a",
      exact: { "p/other:max,p/b": "p/b", "p/other:max": "p/other" },
    });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 1);
  });

  it("sets no effort when the selector carries no suffix", async () => {
    // The second slot gives the cursor somewhere to advance to; the plain
    // selector resolves the literal `p/b` row, so no level is invented.
    const { calls, cursor } = await rotate(["p/b", "p/a"], { rows, startModel: "p/a" });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 1);
  });

  it("sets no effort when the host refuses the model", async () => {
    const { calls, cursor } = await rotate(["p/b:high", "p/a"], {
      rows,
      startModel: "p/a",
      refuse: true,
      exact: { "p/b:high": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 0, "a refusal consumes no slot; two slots make an erroneous advance visible");
  });

  it("sets no effort when the host reports a different active model", async () => {
    const { calls, cursor } = await rotate(["p/b:high", "p/a"], {
      rows,
      startModel: "p/a",
      currentAfter: "p/other",
      exact: { "p/b:high": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 0, "a mismatch consumes no slot; two slots make an erroneous advance visible");
  });
});

describe("effort: degraded hosts still consume an accepted model", () => {
  it("warns and keeps the accepted model when the host exposes no setter", async () => {
    const { calls, cursor, logs, notified } = await rotate(["p/b:high", "p/a"], {
      rows,
      startModel: "p/a",
      withSetter: false,
      exact: { "p/b:high": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 1, "the accepted model is consumed");
    assert.match(effortWarnText(logs), /no setThinkingLevel/i);
    assert.ok(
      notified.every(([message]) => !/thinking level|effort/i.test(message)),
      "no notification implies the effort succeeded",
    );
  });

  it("warns and keeps the accepted model when the setter throws", async () => {
    const { cursor, logs, notified } = await rotate(["p/b:high", "p/a"], {
      rows,
      startModel: "p/a",
      setterThrows: true,
      exact: { "p/b:high": "p/b" },
    });
    assert.equal(cursor, 1, "a throwing setter does not undo the cursor");
    assert.match(effortWarnText(logs), /thinking level high was not applied|setter threw/i);
    assert.ok(
      notified.every(([message]) => !/thinking level|effort/i.test(message)),
      "no notification implies the effort succeeded",
    );
  });

  it("warns that :auto cannot be selected and keeps the model default", async () => {
    const { calls, cursor, logs } = await rotate(["p/b:auto", "p/a"], {
      rows,
      startModel: "p/a",
      exact: { "p/b:auto": "p/b" },
    });
    assert.deepEqual(calls, ["setModel:p/b"]);
    assert.equal(cursor, 1, "an explicit :auto still consumes the accepted model");
    assert.match(effortWarnText(logs), /auto/i);
  });

  it("suppresses a prefix whose resolved id already carries the canonical level", async () => {
    // `p/b:hi` must reach the host as written and resolve the literal `b:high`
    // row. The resolved id ends in the canonical level, so the request is
    // suppressed silently: no setter call and no warning. With the setter
    // present, a production rewrite that treats `:hi` as an explicit `high`
    // request calls the setter and fails this assertion; a rewrite that strips
    // the suffix resolves no plain `b` row and never advances the cursor.
    const fuzzyRows = [
      { provider: "p", id: "b:high" },
      { provider: "p", id: "a" },
    ];
    const { calls, cursor, logs } = await rotate(["p/b:hi", "p/a"], {
      rows: fuzzyRows,
      startModel: "p/a",
      exact: { "p/b:hi": "p/b:high" },
    });
    assert.deepEqual(calls, ["setModel:p/b:high"], "the literal row is applied as-is");
    assert.equal(cursor, 1, "the accepted literal id is consumed");
    assert.equal(effortWarnText(logs), "", "the suppression is silent");
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
        exact: { "p/b:high": "p/b" },
      });
      assert.deepEqual(calls, ["setModel:p/b", "setThinkingLevel:high"]);
      const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.equal(persisted.counters.default, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("effort: the level is set only after the apply settles and current() agrees", () => {
  it("holds setThinkingLevel until setModel settles with a matching current()", async () => {
    mod.resetCounters();
    const harness = makeHarness();
    let releaseApply;
    const settled = new Promise((resolve) => {
      releaseApply = resolve;
    });
    let invokedApply;
    const appliedCall = new Promise((resolve) => {
      invokedApply = resolve;
    });
    const baseSetModel = harness.pi.setModel;
    harness.pi.setModel = async (model) => {
      invokedApply();
      const appliedRow = await baseSetModel(model);
      await settled;
      if (appliedRow !== false) {
        models.setCurrent("p/b");
      }
      return appliedRow;
    };
    mod.default(harness.pi, { pools: { default: ["p/b:high", "p/a"] } });
    const models = makeModels(rows, "p/a", { "p/b:high": "p/b" });
    const ctx = freshMainCtx(models, harness.notified);
    const pending = harness.handlers.session_start({ type: "session_start" }, ctx);
    await appliedCall;
    assert.deepEqual(harness.calls, ["setModel:p/b"], "the model request was made");
    assert.ok(!harness.calls.includes("setThinkingLevel:high"), "no level is set while the apply is pending");
    assert.equal(
      mod.getCounters().default ?? 0,
      0,
      "the slot is not consumed while the apply is pending",
    );
    releaseApply();
    await pending;
    assert.deepEqual(
      harness.calls,
      ["setModel:p/b", "setThinkingLevel:high"],
      "the level is set after the apply settles",
    );
    assert.equal(
      mod.getCounters().default ?? 0,
      1,
      "the accepted model is consumed after the apply settles",
    );
  });
});

describe("effort: no request is invented for manual picks or subagents", () => {
  it("passes a suffixed subagent selector through untouched and sets no level", async () => {
    mod.resetCounters();
    const harness = makeHarness();
    mod.default(harness.pi, { pools: { slow: ["p/b:high", "p/a"] } });
    // The role pool's first slot is the raw selector itself: the fake registry
    // maps that spelling to the model the host would resolve, so the intended
    // first slot is eligible and accepted instead of falling to the second.
    const models = makeModels(rows, undefined, { "p/b:high": "p/b" });
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
    assert.deepEqual(
      result?.model,
      ["p/b:high", "p/a"],
      "the full default capped payload: the picked slot first, then one fallback",
    );
    assert.equal(mod.getCounters().slow, 1, "the accepted first slot is consumed");
    assert.deepEqual(harness.calls, [], "a subagent spawn never drives the main-session setter");
  });
});
