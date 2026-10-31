// Deterministic tests for the `/model-pool` command surface.
//
// `dist/index.js` is imported as built; `node --test` runs this file in its own
// process, so the module-level configuration state is per-file. Assertions are
// about real behaviour (`getPools`, `getCounters`, the object handed to
// `setModel`, the provider handed to `registerProvider`), not log text alone.

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
  // Nothing in these tests writes config unless it opts in, but isolating the
  // agent dir keeps any default-file read away from the operator's real ~/.omp.
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

// The spawn contract: only `patterns[0]` is inspected, and it must name a pool.
const SLOW_EVENT = {
  type: "before_subagent_spawn",
  agent: "reviewer",
  invocationKind: "task",
  patterns: ["pool/slow"],
};

describe("command registration", () => {
  it("registers /model-pool, both routing hooks, and the pool provider", () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });

    assert.equal(host.command.registered, true);
    assert.equal(host.command.name, "model-pool");
    assert.equal(typeof host.command.options.description, "string");
    assert.equal(typeof host.command.options.handler, "function");
    assert.equal(typeof host.handlers.before_subagent_spawn, "function");
    assert.equal(typeof host.handlers.session_start, "function");

    // Each pool is published as the model `pool/<name>`.
    assert.equal(mod.POOL_PROVIDER, "pool");
    const published = host.providers.filter(([name]) => name === mod.POOL_PROVIDER);
    assert.equal(published.length, 1, "the pool provider was registered once");
    assert.deepEqual(
      published[0][1].models.map((model) => model.id),
      ["slow"],
    );
  });

  it("survives a missing registerCommand and still routes a pool pick", async () => {
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
    const result = await host.handlers.before_subagent_spawn(SLOW_EVENT, host.subCtx(models));
    assert.equal(result.model[0], "p/a");
    assert.deepEqual(result.model, ["p/a", "p/b"], "the rest of the pool becomes the retry chain");
    assert.match(result.note, /^pool\/slow\[1\/2\]: p\/a$/);
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

  it("still routes pools when the host cannot register providers", async () => {
    const host = createFakeHost({ registerProvider: false });
    assert.doesNotThrow(() => mod.default(host.pi, { pools: { slow: ["p/a"] } }));
    assert.ok(
      host.logs.some(([level, msg]) => level === "warn" && msg.includes("cannot register providers")),
      "the missing provider capability is reported once",
    );

    const result = await host.handlers.before_subagent_spawn(
      SLOW_EVENT,
      host.subCtx(host.models(["p/a"])),
    );
    assert.deepEqual(result.model, ["p/a"]);
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

  it("offers a pool model as the current one and can switch away from it", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });
    // The session is running on the pool's own model; the registry only lists
    // the real members, so the pool id itself is not a selectable candidate.
    const models = host.models(["p/a", "p/b"], { provider: "pool", id: "slow" });
    host.pi.setModel = async (model) => {
      host.setModels.push(model);
      models.setCurrent({ provider: model.provider, id: model.id });
    };
    host.pushSelect("p/b");
    await runCommand(host, "pick", host.mainCtx(models));

    assert.deepEqual(host.setModels, [{ provider: "p", id: "b" }]);
    assert.ok(host.notified.some(([msg]) => msg.includes("switched to p/b")));
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
  it("creates a pool, adds a model, and reports runtime-only without touching counters", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    const models = host.models(["p/a", "p/b"]);

    host.pushSelect("New pool…");
    host.pushInput("slow");
    host.pushSelect("Add model…");
    host.pushSelect("p/a");
    await runCommand(host, "edit", host.mainCtx(models));

    assert.deepEqual(pools(), { slow: ["p/a"] });
    assert.equal(mod.getConfigSource().writable, false);
    assert.ok(host.notified.some(([msg]) => msg.includes("runtime-only")));
    assert.deepEqual(counters(), {});
  });

  it("re-publishes the pool provider after a new pool is created", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    assert.deepEqual(host.registeredModels(mod.POOL_PROVIDER), [], "nothing is published for zero pools");

    host.pushSelect("New pool…");
    host.pushInput("slow");
    host.pushSelect("Add model…");
    host.pushSelect("p/a");
    await runCommand(host, "edit", host.mainCtx(host.models(["p/a"])));

    const ids = host.registeredModels(mod.POOL_PROVIDER).map((model) => model.id);
    assert.deepEqual(ids, ["slow"], "the host received a model list containing the new pool");
    assert.ok(
      host.providers.some(([name]) => name === mod.POOL_PROVIDER),
      "registerProvider was called with the pool provider",
    );
  });

  it("shows the configured order, availability and counter policy before editing", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/missing"] } });
    host.pushSelect("Back");
    const beforeCounters = counters();

    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    const summary = host.notified.map(([msg]) => msg).find((msg) => msg.includes("order:"));
    assert.ok(summary, "the editor announces the pool before offering actions");
    assert.ok(summary.includes("pool/slow"), "the summary names the pool as a model id");
    assert.ok(summary.includes("1. p/a (available)"));
    assert.ok(summary.includes("2. p/missing (unavailable: unresolved)"));
    assert.ok(summary.includes("counters are process-local"));
    assert.ok(summary.includes("editing never moves the cursor"));
    // Reading the summary must not draw from the rotation.
    assert.deepEqual(counters(), beforeCounters);
    assert.deepEqual(pools(), { slow: ["p/a", "p/missing"] });
  });

  it("lists configured pools by their pool/<name> model id", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });
    host.pushSelect("Back"); // top-level list: cancel

    await runCommand(host, "edit", host.mainCtx(host.models(["p/a"])));

    const [, options] = host.calls.select[0];
    const labels = options.map((option) => (typeof option === "string" ? option : option.label));
    assert.ok(labels.includes("pool/slow"), "the pool appears under the id it is selected with");
    assert.ok(labels.includes("New pool…"));
  });

  it("explains that a new pool applies only where it is selected", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: {} });
    host.pushSelect("New pool…");
    host.pushInput("slow");
    host.pushSelect("Back");

    await runCommand(host, "edit", host.mainCtx(host.models(["p/a"])));

    assert.ok(
      host.notified.some(([msg]) => msg.includes("pool/slow takes effect only where you select it")),
      "the operator is told the pool is not auto-applied to a role",
    );
    assert.deepEqual(pools(), {}, "entering a new pool name must not create a pool by itself");
  });

  it("rejects an invalid pool name and leaves the file untouched", async () => {
    const configPath = path.join(tmpDir, "model-pools.json");
    const original = `${JSON.stringify({ pools: { slow: ["p/a"] } }, null, 2)}\n`;
    fs.writeFileSync(configPath, original);
    process.env.OMP_MODEL_POOL_CONFIG = configPath;

    const host = createFakeHost();
    mod.default(host.pi);
    assert.equal(mod.getConfigSource().writable, true, "the temp config is the writable source");

    // The editor refuses the name up front...
    host.pushSelect("New pool…");
    host.pushInput("__proto__");
    await runCommand(host, "edit", host.mainCtx(host.models(["p/a"])));

    assert.ok(
      host.notified.some(([msg, type]) => type === "warning" && msg.includes("a pool name needs")),
      "an invalid name is reported instead of accepted",
    );
    assert.deepEqual(pools(), { slow: ["p/a"] });

    // ...and the save path refuses it too, without rewriting the document.
    const outcome = await mod.savePoolEdit("__proto__", ["p/a"]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /cannot be a pool name/);
    assert.equal(fs.readFileSync(configPath, "utf8"), original, "the config file is unchanged");
    assert.deepEqual(pools(), { slow: ["p/a"] });
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

  it("re-checks membership before saving a newly chosen model", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    const models = host.models(["p/a", "p/b"]);
    // Still listed (so the dialog offers it), but the registry no longer resolves
    // it: the model lost authentication while the picker was open.
    models.resolve = () => undefined;
    host.pushSelect("Add model…");
    host.pushSelect("p/b");
    await runCommand(host, "edit slow", host.mainCtx(models));

    assert.deepEqual(pools(), { slow: ["p/a"] }, "a model that lost authentication is not saved");
    assert.ok(
      host.notified.some(([msg, type]) => type === "warning" && msg.includes("no longer authenticated")),
      "the stale selection is reported, not silently added",
    );
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
    assert.deepEqual(
      host.registeredModels(mod.POOL_PROVIDER),
      [],
      "the deleted pool is not left published as a model",
    );
  });

  it("leaves pools unchanged when the editor is cancelled", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    assert.deepEqual(pools(), { slow: ["p/a"] });
    assert.equal(host.calls.select.length, 2, "the pool action and the pool list were both cancelled");
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

describe("/model-pool menu", () => {
  it("routes the Edit Pools menu item into the pool editor", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    host.pushSelect("Edit Pools");
    host.pushSelect("Back"); // leave the pool list

    await runCommand(host, "", host.mainCtx(host.models(["p/a"])));

    assert.equal(host.calls.select.length, 2, "the menu then the pool list were shown");
    const [, options] = host.calls.select[1];
    const labels = options.map((option) => (typeof option === "string" ? option : option.label));
    assert.ok(labels.includes("pool/slow"));
    assert.deepEqual(pools(), { slow: ["p/a"] }, "opening and leaving the editor changes nothing");
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

    const text = host.notified.map(([msg]) => msg).join("\n");
    assert.ok(text.includes("pool/slow[2]"), "status names the pool by its model id and size");
    assert.ok(/\bpool\/slow:/.test(text), "doctor lists the pool");
    assert.ok(text.includes("unavailable: p/missing — unresolved"), "doctor diagnoses each entry");
    assert.ok(!/main role/i.test(text), "the retired main-role notion is gone");
    assert.ok(text.includes("edit [pool]"), "help documents the pool argument");

    assert.deepEqual(pools(), beforePools);
    assert.deepEqual(counters(), beforeCounters);
  });

  it("reports the tiered diagnosis for every pool", () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/missing"], fast: ["p/a"] } });

    const report = mod.diagnosePools(host.models(["p/a"]));

    assert.equal(report.registryReadable, true);
    assert.match(report.registryNote, /1 authenticated model/);
    assert.deepEqual(report.pools, [
      { pool: "slow", entries: [
        { selector: "p/a", eligible: true, reason: "authenticated as p/a" },
        { selector: "p/missing", eligible: false, reason: "unresolved" },
      ] },
      { pool: "fast", entries: [{ selector: "p/a", eligible: true, reason: "authenticated as p/a" }] },
    ]);
  });

  it("diagnoses an unreadable registry without claiming entries", () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    const broken = {
      list: () => {
        throw new Error("registry down");
      },
      current: () => undefined,
      resolve: () => undefined,
    };

    const report = mod.diagnosePools(broken);

    assert.equal(report.registryReadable, false);
    assert.match(report.registryNote, /registry read failed: registry down/);
    assert.deepEqual(report.pools[0].entries, [
      { selector: "p/a", eligible: false, reason: "unresolved" },
    ]);
  });
});
