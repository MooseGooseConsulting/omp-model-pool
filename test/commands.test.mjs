// Deterministic tests for the `/model-pool` command surface.
//
// `dist/index.js` is imported as built; `node --test` runs this file in its own
// process, so the module-level configuration state is per-file. Assertions are
// about real behaviour (`getPools`, `getCounters`, the object handed to
// `setModel`), not log text alone.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFakeHost } from "./helpers/fake-host.mjs";

const mod = await import("../dist/index.js");

// `getPools()` returns a null-prototype object, which strict deepEqual would
// reject against a plain object literal. Normalize both snapshots to plain
// objects so comparisons are about content.
function pools() {
  return { ...mod.getPools() };
}
function counters() {
  return { ...mod.getCounters() };
}

const ENV_KEYS = [
  "OMP_MODEL_POOLS_JSON",
  "OMP_MODEL_POOL_CONFIG",
  "OMP_MODEL_POOL_STATE",
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CONFIG_DIR",
];

let savedEnv;
let tmpDir;

beforeEach(() => {
  savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // Nothing in these tests writes config, but isolating the agent dir keeps any
  // default-file read away from the operator's real ~/.omp.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cmd-"));
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  mod.resetCounters();
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runCommand(host, args, ctx) {
  return host.command.options.handler(args, ctx);
}

const SLOW_EVENT = {
  type: "before_subagent_spawn",
  agent: "reviewer",
  invocationKind: "task",
  modelRole: "@slow",
  patterns: ["@slow"],
};

describe("command registration", () => {
  it("registers /model-pool and both routing hooks", () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });

    assert.equal(host.command.registered, true);
    assert.equal(host.command.name, "model-pool");
    assert.equal(typeof host.command.options.description, "string");
    assert.equal(typeof host.command.options.handler, "function");
    assert.equal(typeof host.handlers.before_subagent_spawn, "function");
    assert.equal(typeof host.handlers.session_start, "function");
  });

  it("survives a missing registerCommand and still routes a pool pick", () => {
    const host = createFakeHost({ registerCommand: false });
    assert.doesNotThrow(() => mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } }));

    assert.equal(host.command.registered, false);
    assert.ok(
      host.logs.some(([level, msg]) => level === "warn" && msg.includes("registerCommand")),
      "a compatibility warning is logged",
    );
    assert.equal(typeof host.handlers.before_subagent_spawn, "function");
    assert.equal(typeof host.handlers.session_start, "function");

    const models = host.models(["p/a", "p/b"]);
    const result = host.handlers.before_subagent_spawn(SLOW_EVENT, host.subCtx(models));
    assert.equal(result.model, "p/a");
    assert.equal(counters().slow, 1);
  });

  it("survives a throwing registerCommand and still registers hooks", () => {
    const host = createFakeHost({ registerCommand: "throw" });
    assert.doesNotThrow(() => mod.default(host.pi, { pools: { slow: ["p/a"] } }));

    assert.equal(host.command.registered, false);
    assert.ok(
      host.logs.some(([level, msg]) => level === "warn" && msg.includes("could not register")),
      "the failed registration is reported",
    );
    assert.equal(typeof host.handlers.before_subagent_spawn, "function");
    assert.equal(typeof host.handlers.session_start, "function");
  });
});

describe("/model-pool pick", () => {
  it("warns in a sub session and never mutates", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });
    await runCommand(host, "pick", host.subCtx(host.models(["p/a", "p/b"])));

    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("main session only")));
    assert.deepEqual(host.setModels, []);
    assert.equal(host.calls.select.length, 0);
    assert.equal(host.calls.input.length, 0);
  });

  it("warns without an interactive UI and shows no dialog", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    await runCommand(host, "pick", host.mainCtx(host.models(["p/a"]), { hasUI: false }));

    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("interactive")));
    assert.deepEqual(host.setModels, []);
    assert.equal(host.calls.select.length, 0);
  });

  it("warns while the session is busy", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    await runCommand(host, "pick", host.mainCtx(host.models(["p/a"]), { isIdle: () => false }));

    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("busy")));
    assert.deepEqual(host.setModels, []);
  });

  it("treats an empty select (cancel) as a no-op", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    await runCommand(host, "pick", host.mainCtx(host.models(["p/a", "p/b"])));

    assert.ok(host.notified.some(([msg]) => msg.includes("cancelled")));
    assert.deepEqual(host.setModels, []);
    assert.equal(host.calls.select.length, 1, "the dialog was shown and then cancelled");
  });

  it("reports a no-op when the current model is chosen", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    const models = host.models(["p/a", "p/b"], "p/a");
    host.pushSelect("p/a");
    await runCommand(host, "pick", host.mainCtx(models));

    assert.ok(host.notified.some(([msg]) => msg.includes("already using p/a")));
    assert.deepEqual(host.setModels, []);
  });

  it("applies the resolved model on success and mutates nothing else", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });
    const beforePools = pools();
    const beforeCounters = counters();

    const models = host.models(["p/a", "p/b"]);
    // A host that really applies the model reports it back; success is only
    // claimed once the new active model is confirmed.
    host.pi.setModel = async (model) => {
      host.setModels.push(model);
      models.setCurrent(`${model.provider}/${model.id}`);
    };
    host.pushSelect("p/b");
    await runCommand(host, "pick", host.mainCtx(models));

    assert.equal(host.setModels.length, 1);
    assert.deepEqual(host.setModels[0], { provider: "p", id: "b" });
    assert.ok(host.notified.some(([msg, type]) => type === "info" && msg.includes("switched to p/b")));
    assert.deepEqual(pools(), beforePools);
    assert.deepEqual(counters(), beforeCounters);
  });

  it("does not claim a switch when the host never confirms the active model", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    host.pushSelect("p/b");
    await runCommand(host, "pick", host.mainCtx(host.models(["p/a", "p/b"])));

    assert.equal(host.setModels.length, 1);
    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("did not confirm")));
    assert.ok(!host.notified.some(([msg]) => msg.includes("switched to")), "unconfirmed is not reported as a switch");
  });

  it("reports an error when the host refuses the model", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    host.pi.setModel = async (model) => {
      host.setModels.push(model);
      return false;
    };
    host.pushSelect("p/b");
    await runCommand(host, "pick", host.mainCtx(host.models(["p/a", "p/b"])));

    assert.ok(host.notified.some(([msg, type]) => type === "error" && msg.includes("refused")));
    assert.ok(!host.notified.some(([msg]) => msg.includes("switched to")), "a refusal is not a switch");
  });

  it("reports an error when the session keeps a different model", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    const models = host.models(["p/a", "p/b", "other/model"], "other/model");
    host.pushSelect("p/b");
    await runCommand(host, "pick", host.mainCtx(models));

    assert.equal(host.setModels.length, 1);
    assert.ok(
      host.notified.some(
        ([msg, type]) => type === "error" && msg.includes("session still reports other/model"),
      ),
    );
    assert.ok(!host.notified.some(([msg]) => msg.includes("switched to")));
  });

  it("warns on an empty authenticated registry and errors on a throwing one", async () => {
    const emptyHost = createFakeHost();
    mod.default(emptyHost.pi, { pools: {} });
    await runCommand(emptyHost, "pick", emptyHost.mainCtx(emptyHost.models([])));
    assert.ok(
      emptyHost.notified.some(([msg, type]) => type === "warning" && msg.includes("no authenticated models")),
    );
    assert.deepEqual(emptyHost.setModels, []);

    const throwHost = createFakeHost();
    mod.default(throwHost.pi, { pools: {} });
    const throwing = {
      list: () => {
        throw new Error("registry down");
      },
      current: () => undefined,
      resolve: () => undefined,
    };
    await runCommand(throwHost, "pick", throwHost.mainCtx(throwing));
    assert.ok(
      throwHost.notified.some(([msg, type]) => type === "error" && msg.includes("registry is unavailable")),
    );
    assert.deepEqual(throwHost.setModels, []);
  });

  it("re-checks busy after the dialog and refuses to switch mid-turn", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    let calls = 0;
    const ctx = host.mainCtx(host.models(["p/a", "p/b"]), {
      isIdle: () => {
        calls += 1;
        return calls === 1; // idle before the dialog, busy after
      },
    });
    host.pushSelect("p/b");
    await runCommand(host, "pick", ctx);

    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("became busy")));
    assert.deepEqual(host.setModels, []);
  });
});

describe("/model-pool unknown argument", () => {
  it("warns with a help hint and mutates nothing", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    const beforePools = pools();
    const beforeCounters = counters();

    await runCommand(host, "frobnicate", host.mainCtx(host.models(["p/a"])));

    assert.ok(host.logs.some(([level, msg]) => level === "warn" && msg.includes("help")));
    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("help")));
    assert.deepEqual(pools(), beforePools);
    assert.deepEqual(counters(), beforeCounters);
  });
});

describe("/model-pool edit", () => {
  it("creates a role, adds a model, and reports runtime-only without touching counters", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    const models = host.models(["p/a", "p/b"]);

    host.pushSelect("New role…");
    host.pushInput("slow");
    host.pushSelect("Add model…");
    host.pushSelect("p/a");
    await runCommand(host, "edit", host.mainCtx(models));

    assert.deepEqual(pools(), { slow: ["p/a"] });
    assert.equal(mod.getConfigSource().writable, false);
    assert.ok(host.notified.some(([msg]) => msg.includes("runtime-only")));
    assert.deepEqual(counters(), {});
  });

  it("shows the configured order, availability and counter policy before editing", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/missing"] } });
    host.pushSelect("Back");
    const beforeCounters = counters();

    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    const summary = host.notified.map(([msg]) => msg).find((msg) => msg.includes("order:"));
    assert.ok(summary, "the editor announces the role before offering actions");
    assert.ok(summary.includes("1. p/a (available)"));
    assert.ok(summary.includes("2. p/missing (unavailable: unresolved)"));
    assert.ok(summary.includes("counters are process-local"));
    assert.ok(summary.includes("editing never moves the cursor"));
    // Reading the summary must not draw from the rotation.
    assert.deepEqual(counters(), beforeCounters);
    assert.deepEqual(pools(), { slow: ["p/a", "p/missing"] });
  });

  it("explains that a new role pool does not create an OMP core role", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    host.pushSelect("New role…");
    host.pushInput("slow");
    host.pushSelect("Back");

    await runCommand(host, "edit", host.mainCtx(host.models(["p/a"])));

    assert.ok(
      host.notified.some(([msg]) => msg.includes("does not create or assign an OMP core role")),
    );
    assert.deepEqual(pools(), {}, "entering a new role name must not create a pool by itself");
  });

  it("adds a model to an existing pool", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    host.pushSelect("Add model…");
    host.pushSelect("p/b");
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a", "p/b"])));

    assert.deepEqual(pools(), { slow: ["p/a", "p/b"] });
    assert.deepEqual(counters(), {});
  });

  it("removes a slot", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });
    host.pushSelect("Remove entry…");
    host.pushSelect("2. p/b");
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a", "p/b"])));

    assert.deepEqual(pools(), { slow: ["p/a"] });
    assert.deepEqual(counters(), {});
  });

  it("moves a slot earlier", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });
    host.pushSelect("Move earlier…");
    host.pushSelect("2. p/b");
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a", "p/b"])));

    assert.deepEqual(pools(), { slow: ["p/b", "p/a"] });
    assert.deepEqual(counters(), {});
  });

  it("deletes a pool only after confirmation", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    host.pushSelect("Delete pool");
    host.pushConfirm(true);
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    assert.deepEqual(pools(), {});
    assert.equal(host.calls.confirm.length, 1);
    assert.ok(host.notified.some(([msg]) => msg.includes("runtime-only")));
    assert.deepEqual(counters(), {});
  });

  it("leaves pools unchanged when the editor is cancelled", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    assert.deepEqual(pools(), { slow: ["p/a"] });
    assert.equal(host.calls.select.length, 2, "the role action and the role list were both cancelled");
    assert.equal(host.calls.confirm.length, 0);
  });

  it("warns in a sub session and shows no dialog", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    await runCommand(host, "edit", host.subCtx(host.models(["p/a"])));

    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("main session only")));
    assert.equal(host.calls.select.length, 0);
    assert.deepEqual(pools(), { slow: ["p/a"] });
  });

  it("warns without an interactive UI and shows no dialog", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    await runCommand(host, "edit", host.mainCtx(host.models(["p/a"]), { hasUI: false }));

    assert.ok(host.notified.some(([msg, type]) => type === "warning" && msg.includes("interactive")));
    assert.equal(host.calls.select.length, 0);
    assert.deepEqual(pools(), { slow: ["p/a"] });
  });

  it("honors an inline-JSON source as runtime-only", async () => {
    process.env.OMP_MODEL_POOLS_JSON = JSON.stringify({ slow: ["p/a"] });
    const host = createFakeHost();
    mod.default(host.pi); // no options: config comes from the environment
    assert.deepEqual(pools(), { slow: ["p/a"] });

    host.pushSelect("Add model…");
    host.pushSelect("p/b");
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a", "p/b"])));

    assert.deepEqual(pools(), { slow: ["p/a", "p/b"] });
    assert.equal(mod.getConfigSource().writable, false);
    assert.ok(host.notified.some(([msg]) => msg.includes("runtime-only")));
    assert.deepEqual(counters(), {});
  });
});

describe("/model-pool status, doctor, help", () => {
  it("emit output through the logger and mutate nothing", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/missing"] } });
    const beforePools = pools();
    const beforeCounters = counters();
    const ctx = host.mainCtx(host.models(["p/a"]));

    await runCommand(host, "status", ctx);
    await runCommand(host, "doctor", ctx);
    await runCommand(host, "help", ctx);

    assert.ok(host.logs.some(([level, msg]) => level === "info" && msg.includes("[model-pool]")));
    assert.ok(host.notified.length >= 3);
    assert.deepEqual(pools(), beforePools);
    assert.deepEqual(counters(), beforeCounters);
  });
});
