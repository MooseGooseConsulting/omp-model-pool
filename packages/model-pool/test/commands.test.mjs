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

/** The spawn's first model: the chain is an array once the pool has alternatives. */
const headOf = (model) => (Array.isArray(model) ? model[0] : model);


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
    assert.equal(headOf(result.model), "p/a");
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

  it("deletes a pool only after confirmation, returning to a chooser without it", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    host.pushSelect("Delete pool");
    host.pushConfirm(true);
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    assert.deepEqual(pools(), {});
    assert.equal(host.calls.confirm.length, 1);
    assert.ok(host.notified.some(([msg]) => msg.includes("runtime-only")));
    assert.deepEqual(counters(), {});
    // The next screen is the role chooser, and the deleted role is gone from it.
    assert.equal(host.calls.select.length, 2, "a successful delete reopens the role chooser");
    assert.match(host.calls.select[1][0], /Role pools/);
    // The chooser's options are labelled objects, not sentinel strings.
    const chooserOptions = host.calls.select[1][1];
    assert.deepEqual(
      chooserOptions.map((item) => item?.label ?? item),
      ["New role…", "Back"],
      "the chooser offers the editor's built-in actions",
    );
    assert.ok(
      !chooserOptions.some(
        (item) => `${item?.label ?? ""}${item?.description ?? ""}${item?.value ?? ""}`.includes("@slow"),
      ),
      "the chooser offers no deleted role",
    );
  });

  it("removes the final slot only after confirmation, returning to a chooser without the role", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    host.pushSelect("Remove entry…");
    host.pushSelect("1. p/a");
    host.pushConfirm(true);
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    assert.deepEqual(pools(), {}, "the last slot's removal deletes the role pool");
    assert.equal(host.calls.confirm.length, 1, "removing the final slot confirms first");
    assert.equal(host.calls.select.length, 3, "the editor returns to the role chooser");
    const [, , chooser] = host.calls.select;
    assert.ok(
      !chooser[1].some((item) => `${item?.value ?? ""}${item?.label ?? ""}`.includes("slow")),
      "the removed role is not offered again",
    );
  });

  it("reopens the existing role when the delete confirmation is declined", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    host.pushSelect("Delete pool");
    host.pushConfirm(false);
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    assert.deepEqual(pools(), { slow: ["p/a"] }, "a declined confirmation deletes nothing");
    assert.equal(host.calls.confirm.length, 1);
    assert.equal(host.notified.length, 1, "no save was attempted, so no outcome is reported");
    // A declined confirmation reopens the role editor — the third screen the
    // user sees is the same role's actions — and then the chooser.
    assert.equal(
      host.calls.select.length,
      3,
      "a declined confirmation reopens the role editor, then the chooser",
    );
    assert.match(host.calls.select[1][0], /@slow/);
    assert.ok(
      host.calls.select[1][1].some((item) => (item?.label ?? item) === "Delete pool"),
      "the editor still offers the declined action",
    );
    assert.ok(
      host.calls.select[2][1].some((item) => `${item?.label ?? ""}${item?.value ?? ""}`.includes("@slow")),
      "the reopened chooser still offers the undeleted role",
    );
  });

  it("reopens the existing role when the save fails, reporting the failure", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    host.pushSelect("Delete pool");
    // A concurrent edit commits while the confirmation dialog is open, so the
    // editor's captured revision is stale and the save is refused.
    host.pushConfirm(() => {
      mod.configurePools({ pools: { slow: ["p/a"] } });
      return true;
    });
    await runCommand(host, "edit slow", host.mainCtx(host.models(["p/a"])));

    assert.deepEqual(pools(), { slow: ["p/a"] }, "a failed save changes nothing");
    assert.ok(
      host.notified.some(
        ([msg, type]) => type === "error" && msg.includes("configuration changed since this edit started"),
      ),
      "the failed save is reported",
    );
    assert.ok(
      !host.notified.some(([msg]) => msg.includes("deleted @slow")),
      "the failure is not reported as a delete",
    );
    // A failed save reopens the role editor — the third screen is the same
    // role's actions — and then the chooser.
    assert.equal(host.calls.select.length, 3, "a failed save reopens the role editor, then the chooser");
    assert.match(host.calls.select[1][0], /@slow/);
    assert.ok(
      host.calls.select[2][1].some((item) => `${item?.label ?? ""}${item?.value ?? ""}`.includes("@slow")),
      "the reopened chooser still offers the unsaved role",
    );
    assert.ok(
      host.calls.select[1][1].some((item) => (item?.label ?? item) === "Delete pool"),
      "the editor still offers its actions after a failed save",
    );
  });

  it("shows a fresh summary when Back is followed by reselecting the role after registry changes", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a", "p/b"] } });
    const models = host.models(["p/a", "p/b"]);
    // p/b loses authentication while the chooser is open; `list()` is what the
    // editor's summaries read, so the change is visible to them only.
    let listed = models.list();
    models.list = () => listed.map((m) => ({ ...m }));

    // The chooser offers labelled roles and `pickLabeled` looks the answer up
    // by label, so the queue must return "@slow", not the bare role key.
    host.pushSelect(() => {
      listed = listed.filter((m) => m.id !== "b");
      return "Back";
    });
    host.pushSelect("@slow");
    host.pushSelect("Back");
    await runCommand(host, "edit slow", host.mainCtx(models));

    const summaries = host.notified.filter(([msg]) => msg.includes("order:"));
    assert.equal(summaries.length, 2, "re-entering the role announces a fresh summary");
    assert.match(summaries[0][0], /2\. p\/b \(available\)/, "the first summary saw the old registry");
    assert.match(summaries[1][0], /1\. p\/a \(available\)/, "the second summary sees the change");
    assert.match(
      summaries[1][0],
      /2\. p\/b \(unavailable: not authenticated \(p\/b is not in the registry list\)\)/,
      "the second summary is not the stale one",
    );
    // Back re-enters the role's editor and only then returns to the chooser.
    assert.match(host.calls.select[2][0], /@slow/, "the reselected role reopens its editor");
    assert.equal(host.calls.select[3][0].includes("Role pools"), true, "Back reopens the role chooser");
    assert.deepEqual(pools(), { slow: ["p/a", "p/b"] });
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

// ---------------------------------------------------------------------------
// `/model-pool doctor`: the registered command's actual output.
//
// Every assertion reads what the command reports, never the helper's return
// value, so a mislabelled reason or a second registry read cannot hide behind
// it. The file-level hooks isolate the agent dir, clear the pool config and
// reset the counters, so this suite needs none of its own.
// ---------------------------------------------------------------------------
describe("/model-pool doctor (registered command)", () => {
  it("judges every entry against one snapshot, resolving each entry once", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["@fallback", "p/ghost", "p/idless", "p/unlisted"] } });
    const models = host
      .mainCtx(host.models(["p/a", "p/b"], undefined, { fallback: ["p/a", "p/b"] }))
      .models;
    const listCalls = [];
    const resolveCalls = [];
    const rawList = models.list;
    const rawResolve = models.resolve;
    models.list = () => {
      listCalls.push(1);
      return rawList();
    };
    models.resolve = (spec) => {
      resolveCalls.push(String(spec));
      // `p/idless` is an entry the host resolves to a row with no id at all,
      // and `p/unlisted` one it resolves although it never lists it.
      if (spec === "p/idless") return { provider: "p", id: "" };
      if (spec === "p/unlisted") return { provider: "p", id: "unlisted" };
      return rawResolve(spec);
    };

    await runCommand(host, "doctor", host.mainCtx(models));

    assert.equal(listCalls.length, 1, "one registry listing per invocation");
    assert.deepEqual(
      resolveCalls,
      ["@fallback", "p/ghost", "p/idless", "p/unlisted"],
      "one resolution per configured entry",
    );

    // The actual output: the alias falls back to its first configured entry and
    // reports that row's identity; unresolved, identity-less and unlisted
    // entries each say so, and only the registry's own note describes it.
    const text = host.notified.at(-1)[0];
    assert.match(text, /registry: registry readable, 2 authenticated model\(s\)/);
    assert.match(text, /ok: @fallback — authenticated as p\/a\b/);
    assert.match(text, /unavailable: p\/ghost — unresolved\b/);
    assert.match(text, /unavailable: p\/idless — resolved without an identity\b/);
    assert.match(
      text,
      /unavailable: p\/unlisted — not authenticated \(p\/unlisted is not in the registry list\)/,
    );
    assert.ok(!text.includes("@fallback — not authenticated"), "the fallback entry is never mislabelled");
  });

  it("distinguishes an unreadable from an empty registry in its actual output", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    const models = host.mainCtx(host.models(["p/a"])).models;
    let throwsNow = true;
    models.list = () => {
      if (throwsNow) throw new Error("registry down");
      return [];
    };

    await runCommand(host, "doctor", host.mainCtx(models));
    const unreadable = host.notified.at(-1)[0];
    assert.match(unreadable, /registry: registry read failed: registry down/);
    assert.match(unreadable, /unavailable: p\/a — registry unreadable/);
    assert.ok(!unreadable.includes("not authenticated"), "unreadable is never unauthenticated");

    throwsNow = false;
    await runCommand(host, "doctor", host.mainCtx(models));
    const empty = host.notified.at(-1)[0];
    assert.match(empty, /registry: registry readable, no authenticated models/);
    assert.match(empty, /unavailable: p\/a — not authenticated \(p\/a is not in the registry list\)/);
    assert.ok(!empty.includes("registry unreadable"), "an empty registry is not unreadable");
  });

  it("preserves absent-registry reporting and mutates nothing", async () => {
    const host = createFakeHost();
    mod.default(host.pi, { pools: { slow: ["p/a"] } });
    const beforeCounters = counters();

    await runCommand(host, "doctor", host.mainCtx(undefined));

    const text = host.notified.at(-1)[0];
    assert.match(text, /registry: model registry unavailable/);
    assert.match(text, /unavailable: p\/a — registry unavailable/);
    assert.ok(!text.includes("not authenticated"));
    assert.deepEqual(counters(), beforeCounters, "doctor never advances a counter");
    assert.equal(
      fs.existsSync(mod.resolveDefaultConfigFilePath()),
      false,
      "doctor writes no config file",
    );
  });
});
