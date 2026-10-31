import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mod = await import("../dist/index.js");

// Every test isolates itself: a fresh temp dir is the OMP agent dir (so the
// default config path can never be the real ~/.omp), the pool-config env vars
// are cleared, and the module counters are reset. `node --test` isolates files
// but not tests within a file, so each test must also present a distinct config
// source signature to force a reload of module state.
const ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "OMP_MODEL_POOLS_JSON",
  "OMP_MODEL_POOL_CONFIG",
  "OMP_MODEL_POOL_STATE",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CONFIG_DIR",
];

let tmpDirs = [];
let savedEnv = {};

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cfg-"));
  tmpDirs.push(dir);
  return dir;
}

function writeText(file, text) {
  fs.writeFileSync(file, text);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function makeHarness() {
  const handlers = {};
  const commands = {};
  const logs = [];
  const setModels = [];
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerCommand: (name, options) => {
      commands[name] = options;
    },
    setModel: async (model) => {
      setModels.push(model);
    },
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      debug: (...a) => logs.push(["debug", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
  };
  return { handlers, commands, logs, setModels, pi };
}

function parseSelector(spec) {
  const i = String(spec).indexOf("/");
  return i >= 0
    ? { provider: String(spec).slice(0, i), id: String(spec).slice(i + 1) }
    : { provider: "", id: String(spec) };
}

// A registry whose `list()` (authenticated) and `resolve()` (known selectors)
// can be controlled independently — the difference between them is exactly what
// authenticated membership means.
function modelsFrom({ listed = [], resolvable = listed, listThrows = false, resolveThrows = false } = {}) {
  const listedModels = listed.map(parseSelector);
  const resolvableSet = new Set(resolvable);
  return {
    list: () => {
      if (listThrows) throw new Error("registry down");
      return listedModels.map((m) => ({ ...m }));
    },
    current: () => undefined,
    resolve: (spec) => {
      if (resolveThrows) throw new Error("resolve down");
      const t = String(spec).trim();
      return resolvableSet.has(t) ? parseSelector(t) : undefined;
    },
  };
}

function subCtx(models) {
  return {
    agent: { kind: "sub", name: "task", id: "1" },
    models,
    ui: { notify: () => {} },
  };
}

const ROUTE_EV = {
  type: "before_subagent_spawn",
  agent: "reviewer",
  invocationKind: "task",
  modelRole: "@slow",
  patterns: ["@slow"],
};

function warns(logs) {
  return logs.filter(([level]) => level === "warn").map(([, message]) => message);
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = freshDir();
  mod.resetCounters();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tmpDirs = [];
});

describe("configuration precedence and provenance", () => {
  it("A1: inline OMP_MODEL_POOLS_JSON is runtime-only and wins", () => {
    process.env.OMP_MODEL_POOLS_JSON = JSON.stringify({ slow: ["p/inline-a1"] });
    const { pi } = makeHarness();
    mod.default(pi);
    const src = mod.getConfigSource();
    assert.equal(src.kind, "inline-env");
    assert.equal(src.writable, false);
    assert.deepEqual(mod.getPools().slow, ["p/inline-a1"]);
  });

  it("A2: an explicit OMP_MODEL_POOL_CONFIG file is writable with a resolved path", () => {
    const file = path.join(freshDir(), "pools.json");
    writeJson(file, { pools: { slow: ["p/a"] } });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);
    const src = mod.getConfigSource();
    assert.equal(src.kind, "file-env");
    assert.equal(src.writable, true);
    assert.equal(src.path, path.resolve(file));
    assert.deepEqual(mod.getPools().slow, ["p/a"]);
  });

  it("A3: the profile default file is used when nothing higher-priority exists", () => {
    const file = mod.resolveDefaultConfigFilePath();
    writeJson(file, { pools: { slow: ["p/default"] } });
    const { pi } = makeHarness();
    mod.default(pi);
    const src = mod.getConfigSource();
    assert.equal(src.kind, "default-file");
    assert.equal(src.writable, true);
    assert.equal(src.path, mod.resolveDefaultConfigFilePath());
    assert.deepEqual(mod.getPools().slow, ["p/default"]);
  });

  it("A4: no configuration at all reports kind none and empty pools", () => {
    const { pi } = makeHarness();
    mod.default(pi);
    const src = mod.getConfigSource();
    assert.equal(src.kind, "none");
    assert.equal(src.writable, true);
    assert.deepEqual(Object.keys(mod.getPools()), []);
  });

  it("A5: malformed inline JSON warns and falls through without throwing", () => {
    process.env.OMP_MODEL_POOLS_JSON = "{ not json";
    const { pi, logs } = makeHarness();
    assert.doesNotThrow(() => mod.default(pi));
    assert.ok(
      warns(logs).some((m) => m.includes("OMP_MODEL_POOLS_JSON") && m.includes("not valid JSON")),
      "a warning is logged for the malformed inline source",
    );
    assert.equal(mod.getConfigSource().kind, "none");
    assert.deepEqual(Object.keys(mod.getPools()), []);
  });

  it("A6: a malformed explicit file is not writable and refuses edits", async () => {
    const file = path.join(freshDir(), "broken.json");
    writeText(file, "{ not json");
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi, logs } = makeHarness();
    mod.default(pi);
    assert.equal(mod.getConfigSource().writable, false);
    assert.ok(warns(logs).some((m) => m.includes("could not be read")));
    // Spec: an unreadable authoritative source disables saving -> { ok: false }.
    const outcome = await mod.savePoolEdit("slow", ["p/a"]);
    assert.equal(
      outcome.ok,
      false,
      `src/index.ts defect: savePoolEdit accepted the edit as runtime-only instead of refusing; got ${JSON.stringify(outcome)}`,
    );
  });

  it("A7: programmatic options are runtime-only and take precedence", () => {
    const { pi } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/opt"] } });
    const src = mod.getConfigSource();
    assert.equal(src.kind, "options");
    assert.equal(src.writable, false);
    assert.deepEqual(mod.getPools().slow, ["p/opt"]);
  });

  it("A8: a malformed explicit file falls through to the default file for routing but disables editing", async () => {
    const bad = path.join(freshDir(), "broken.json");
    writeText(bad, "{ not json");
    writeJson(mod.resolveDefaultConfigFilePath(), { pools: { slow: ["p/from-default"] } });
    process.env.OMP_MODEL_POOL_CONFIG = bad;
    const { pi, logs } = makeHarness();
    mod.default(pi);

    // Routing still follows the documented precedence (the default file is the
    // next source), but the broken higher-priority source blocks all editing.
    assert.equal(mod.getConfigSource().kind, "default-file");
    assert.equal(mod.getConfigSource().writable, false);
    assert.deepEqual(mod.getPools().slow, ["p/from-default"]);
    assert.ok(warns(logs).some((m) => m.includes("could not be read")));

    const outcome = await mod.savePoolEdit("slow", ["p/x"]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /disabled/);
  });

  it("A9: diagnostics show 'editing disabled', not the runtime-only label, for a disabled source", async () => {
    const bad = path.join(freshDir(), "broken.json");
    writeText(bad, "{ not json");
    writeJson(mod.resolveDefaultConfigFilePath(), { pools: { slow: ["p/from-default"] } });
    process.env.OMP_MODEL_POOL_CONFIG = bad;
    const { pi, commands } = makeHarness();
    mod.default(pi);
    assert.equal(mod.getConfigSource().writable, false);

    const seen = [];
    const ctx = {
      agent: { kind: "main", name: "main", id: "Main" },
      models: modelsFrom({ listed: ["p/from-default"] }),
      ui: { notify: (message) => seen.push(message) },
    };
    await commands["model-pool"].handler("status", ctx);
    await commands["model-pool"].handler("doctor", ctx);

    const configLines = seen.filter((m) => m.includes("config:"));
    assert.ok(
      configLines.length >= 2,
      `status and doctor both report the config source; got ${JSON.stringify(seen)}`,
    );
    assert.ok(
      configLines.some((m) => m.includes("editing disabled")),
      "a disabled source is labelled 'editing disabled', not 'runtime-only'",
    );
    assert.ok(
      !configLines.some((m) => m.includes("runtime-only")),
      "a disabled source is never mislabelled 'runtime-only'",
    );
  });

  it("A10: a nested document whose pools value is not an object disables editing", async () => {
    const file = path.join(freshDir(), "badpools.json");
    writeText(file, '{ "pools": [] }\n');
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi, logs } = makeHarness();
    mod.default(pi);
    assert.equal(mod.getConfigSource().writable, false);
    assert.ok(warns(logs).some((m) => m.includes('"pools" key must be a JSON object')));

    const before = fs.readFileSync(file, "utf8");
    const outcome = await mod.savePoolEdit("slow", ["p/a"]);
    assert.equal(outcome.ok, false, "a document we cannot understand must not be edited");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the malformed document is left untouched");
  });
});

describe("default-file discovery and no-write-on-load", () => {
  it("B8: resolveDefaultConfigFilePath honors PI_CODING_AGENT_DIR, then the profile", () => {
    const base = process.env.PI_CODING_AGENT_DIR;
    assert.equal(
      mod.resolveDefaultConfigFilePath(),
      path.join(path.resolve(base), "model-pool.json"),
    );
    process.env.OMP_PROFILE = "work";
    assert.equal(
      mod.resolveDefaultConfigFilePath(),
      path.join(os.homedir(), ".omp", "profiles", "work", "agent", "model-pool.json"),
    );
  });

  it("B9: loading, status and doctor never create the default file", async () => {
    const { pi, commands } = makeHarness();
    mod.default(pi);
    const file = mod.resolveDefaultConfigFilePath();
    assert.equal(fs.existsSync(file), false, "loading must not create the config file");
    const ctx = {
      agent: { kind: "main", name: "main", id: "Main" },
      models: modelsFrom({ listed: ["p/a"] }),
      ui: { notify: () => {} },
    };
    await commands["model-pool"].handler("status", ctx);
    await commands["model-pool"].handler("doctor", ctx);
    assert.equal(fs.existsSync(file), false, "status and doctor are read-only");
  });
});

describe("automatic save transactions", () => {
  it("C10: the first edit creates the nested default file and a reload sees it", async () => {
    const { pi } = makeHarness();
    mod.default(pi);
    assert.equal(mod.getConfigSource().kind, "none");
    const file = mod.resolveDefaultConfigFilePath();
    assert.equal(fs.existsSync(file), false);

    const outcome = await mod.savePoolEdit("slow", ["p/a"]);
    assert.deepEqual(outcome, { ok: true, runtimeOnly: false });
    assert.deepEqual(readJson(file), { pools: { slow: ["p/a"] } });

    const { pi: pi2 } = makeHarness();
    mod.default(pi2);
    assert.deepEqual(mod.getPools().slow, ["p/a"]);
  });

  it("C11: a nested edit preserves unrelated top-level keys and other roles", async () => {
    const file = path.join(freshDir(), "nested.json");
    writeJson(file, {
      pools: { slow: ["p/a"], fast: ["p/b"] },
      persistCounters: false,
      strict: false,
      custom: { keep: true },
    });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("slow", ["p/a", "p/c"]);
    assert.equal(outcome.ok, true);
    const doc = readJson(file);
    assert.deepEqual(doc.pools.slow, ["p/a", "p/c"]);
    assert.deepEqual(doc.pools.fast, ["p/b"]);
    assert.equal(doc.persistCounters, false);
    assert.equal(doc.strict, false);
    assert.deepEqual(doc.custom, { keep: true });
  });

  it("C12: a flat edit stays flat and preserves other top-level keys", async () => {
    const file = path.join(freshDir(), "flat.json");
    writeJson(file, { slow: ["p/a"], persistCounters: false, note: "keep" });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("slow", ["p/a", "p/b"]);
    assert.equal(outcome.ok, true);
    const doc = readJson(file);
    assert.deepEqual(doc.slow, ["p/a", "p/b"]);
    assert.equal(doc.persistCounters, false);
    assert.equal(doc.note, "keep");
    assert.ok(!Object.prototype.hasOwnProperty.call(doc, "pools"), "a flat file must not gain a pools wrapper");
  });

  it("C13: a flat config refuses role names that collide with reserved keys", async () => {
    const file = path.join(freshDir(), "flat-reserved.json");
    writeJson(file, { slow: ["p/a"] });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    for (const reserved of [
      "pools",
      "mainSessionRole",
      "enableMainSessionRotation",
      "strict",
      "persistCounters",
      "stateFile",
    ]) {
      const outcome = await mod.savePoolEdit(reserved, ["p/x"]);
      assert.equal(outcome.ok, false, `role "${reserved}" must be refused`);
      assert.match(outcome.error, /collides/);
    }
  });

  it("C14: deleting a role removes it, and the last deletion keeps the nested shape", async () => {
    const file = path.join(freshDir(), "delete.json");
    writeJson(file, { pools: { slow: ["p/a"] }, persistCounters: false });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("slow", null);
    assert.deepEqual(outcome, { ok: true, runtimeOnly: false });
    const doc = readJson(file);
    // The empty `pools` key is kept deliberately: dropping it would make the
    // next load read the document as flat, so a later role addition would be
    // written at the top level and silently change the file's shape.
    assert.deepEqual(doc.pools, {});
    assert.equal(doc.persistCounters, false);
    assert.deepEqual(Object.keys(mod.getPools()), []);

    // Prove the shape survived a reload: re-adding the role stays nested.
    const reload = makeHarness();
    mod.default(reload.pi);
    const added = await mod.savePoolEdit("slow", ["p/a"]);
    assert.deepEqual(added, { ok: true, runtimeOnly: false });
    const after = readJson(file);
    assert.deepEqual(after.pools, { slow: ["p/a"] });
    assert.ok(!Object.prototype.hasOwnProperty.call(after, "slow"));
  });

  it("C15: saving an empty pool is refused", async () => {
    const { pi } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    const outcome = await mod.savePoolEdit("slow", []);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /empty pool/);
  });

  it("C16: a missing explicit target is created on the first save, not on load", async () => {
    const file = path.join(freshDir(), "later.json");
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);
    assert.equal(mod.getConfigSource().kind, "file-env");
    assert.equal(mod.getConfigSource().writable, true);
    assert.equal(fs.existsSync(file), false, "loading must not create the file");

    const outcome = await mod.savePoolEdit("slow", ["p/a"]);
    assert.deepEqual(outcome, { ok: true, runtimeOnly: false });
    assert.deepEqual(readJson(file), { pools: { slow: ["p/a"] } });
  });

  it("C17: a stale expectedRevision is refused and changes nothing", async () => {
    const file = path.join(freshDir(), "stale.json");
    writeJson(file, { pools: { slow: ["p/a"] } });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    const revision = mod.getConfigRevision();
    const first = await mod.savePoolEdit("slow", ["p/a", "p/b"], revision);
    assert.equal(first.ok, true);
    const stale = await mod.savePoolEdit("slow", ["p/z"], revision);
    assert.equal(stale.ok, false);
    assert.deepEqual(readJson(file).pools.slow, ["p/a", "p/b"]);
    assert.deepEqual(mod.getPools().slow, ["p/a", "p/b"]);
  });

  it("C18: an out-of-band file change is detected and not overwritten", async () => {
    const file = path.join(freshDir(), "conflict.json");
    writeJson(file, { pools: { slow: ["p/a"] } });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    const external = { pools: { slow: ["p/a", "p/external"] } };
    writeJson(file, external);
    const initialRevision = mod.getConfigRevision();
    const outcome = await mod.savePoolEdit("slow", ["p/b"]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /changed on disk/);
    assert.deepEqual(readJson(file), external, "the external change must survive");
    assert.deepEqual(mod.getPools().slow, ["p/a", "p/external"]);
    const revision = mod.getConfigRevision();
    assert.equal(revision, initialRevision + 1, "the refreshed configuration advances the revision");

    mod.default(pi);
    assert.equal(mod.getConfigRevision(), revision, "the refreshed source signature avoids a redundant reload");

    const retry = await mod.savePoolEdit("slow", ["p/a", "p/external", "p/retry"], revision);
    assert.equal(retry.ok, true, "the refreshed fingerprint allows a deliberate retry");
    assert.deepEqual(readJson(file).pools.slow, ["p/a", "p/external", "p/retry"]);
  });

  it("does not reload the source for an unrelated file read error", async () => {
    const file = path.join(freshDir(), "invalid-after-load.json");
    writeJson(file, { pools: { slow: ["p/a"] } });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    writeText(file, "not json");
    const revision = mod.getConfigRevision();
    const outcome = await mod.savePoolEdit("slow", ["p/b"]);

    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /invalid JSON/);
    assert.equal(mod.getConfigRevision(), revision);
    assert.deepEqual(mod.getPools().slow, ["p/a"]);
  });

  it("C19: a config path equal to the state path is refused", async () => {
    const file = path.join(freshDir(), "collide.json");
    const doc = { pools: { slow: ["p/a"] }, stateFile: file };
    writeJson(file, doc);
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("slow", ["p/a", "p/b"]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /state file/);
    assert.deepEqual(readJson(file), doc);
  });

  it("C20: an inline source edits in memory only and writes no file", async () => {
    process.env.OMP_MODEL_POOLS_JSON = JSON.stringify({ slow: ["p/a"] });
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("slow", ["p/a", "p/b"]);
    assert.deepEqual(outcome, { ok: true, runtimeOnly: true });
    assert.deepEqual(mod.getPools().slow, ["p/a", "p/b"]);
    assert.equal(fs.existsSync(mod.resolveDefaultConfigFilePath()), false);
  });

  it("C19b: a state file aliasing the config lock path is refused", async () => {
    const file = path.join(freshDir(), "lockalias.json");
    const doc = { pools: { slow: ["p/a"] }, stateFile: `${file}.lock`, persistCounters: true };
    writeJson(file, doc);
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("slow", ["p/a", "p/b"]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /state file/);
    assert.deepEqual(readJson(file), doc, "the config file is left untouched");
  });

  it("C21: deleting a role removes an alias key written as '@role'", async () => {
    const file = path.join(freshDir(), "alias.json");
    writeJson(file, { pools: { "@slow": ["p/a"], fast: ["p/b"] } });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);
    // The engine reads '@slow' and 'slow' as the same role.
    assert.deepEqual(mod.getPools()["slow"], ["p/a"]);

    const outcome = await mod.savePoolEdit("slow", null);
    assert.deepEqual(outcome, { ok: true, runtimeOnly: false });
    assert.deepEqual(
      readJson(file).pools,
      { fast: ["p/b"] },
      "the '@slow' key is removed, not left behind to reappear on reload",
    );
  });

  it("C22: a role literally named __proto__ is saved as a JSON property", async () => {
    const file = path.join(freshDir(), "proto.json");
    process.env.OMP_MODEL_POOL_CONFIG = file; // missing: created on the first save
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("__proto__", ["p/a"]);
    assert.deepEqual(outcome, { ok: true, runtimeOnly: false });
    const doc = readJson(file);
    assert.ok(
      Object.prototype.hasOwnProperty.call(doc.pools, "__proto__"),
      "the role is stored as an own data property, not routed to the prototype",
    );
    assert.deepEqual(doc.pools["__proto__"], ["p/a"]);
  });

  it("C23: concurrent edits from the same revision cannot both commit", async () => {
    const file = path.join(freshDir(), "concurrent.json");
    writeJson(file, { pools: { slow: ["p/a"] } });
    process.env.OMP_MODEL_POOL_CONFIG = file;
    const { pi } = makeHarness();
    mod.default(pi);
    const revision = mod.getConfigRevision();

    const [first, second] = await Promise.all([
      mod.savePoolEdit("slow", ["p/a", "p/b"], revision),
      mod.savePoolEdit("fast", ["p/c"], revision),
    ]);
    const committed = [first, second].filter((r) => r.ok).length;
    assert.equal(committed, 1, `exactly one concurrent edit may commit; got ${JSON.stringify([first, second])}`);
  });
});

describe("rebinding and replacement", () => {
  it("D21: a runtime edit survives a re-bind while the inline source is unchanged", async () => {
    process.env.OMP_MODEL_POOLS_JSON = JSON.stringify({ slow: ["p/d21"] });
    const { pi } = makeHarness();
    mod.default(pi);

    const outcome = await mod.savePoolEdit("slow", ["p/d21", "p/d21b"]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.runtimeOnly, true);
    assert.deepEqual(mod.getPools().slow, ["p/d21", "p/d21b"]);

    const { pi: pi2 } = makeHarness();
    mod.default(pi2);
    assert.deepEqual(mod.getPools().slow, ["p/d21", "p/d21b"], "the runtime edit is kept, not reset to the document");
  });

  it("D22: configurePools replaces the active configuration", () => {
    const { pi } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    mod.configurePools({ pools: { fast: ["p/x"] } });
    assert.deepEqual(Object.keys(mod.getPools()), ["fast"]);
    assert.deepEqual(mod.getPools().fast, ["p/x"]);
  });

  it("D23: a runtime edit survives a re-bind with unchanged programmatic options", async () => {
    const { pi } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/d23"] } });
    const edit = await mod.savePoolEdit("slow", ["p/d23", "p/d23b"]);
    assert.deepEqual(edit, { ok: true, runtimeOnly: true });
    assert.deepEqual(mod.getPools().slow, ["p/d23", "p/d23b"]);

    // A child-session re-bind with identical options must not discard the edit.
    mod.default(pi, { pools: { slow: ["p/d23"] } });
    assert.deepEqual(mod.getPools().slow, ["p/d23", "p/d23b"]);

    // Different options are a genuine replacement.
    mod.default(pi, { pools: { slow: ["p/d23c"] } });
    assert.deepEqual(mod.getPools().slow, ["p/d23c"]);
  });

  it("D24: configurePools repoints provenance so a later edit cannot write the loaded file", async () => {
    const file = path.join(freshDir(), "loaded.json");
    writeJson(file, { pools: { slow: ["p/onfile"] } });
    process.env.OMP_MODEL_POOL_CONFIG = file;

    const { pi } = makeHarness();
    mod.default(pi);
    assert.equal(mod.getConfigSource().kind, "file-env");
    assert.equal(mod.getConfigSource().writable, true, "a readable explicit file is writable");

    // A programmatic replacement is runtime-only; it must stop pointing at the
    // file loaded a moment ago, or an accepted edit would merge the programmatic
    // pools into that unrelated document.
    mod.configurePools({ pools: { fast: ["p/prog"] } });
    assert.equal(mod.getConfigSource().kind, "options");
    assert.equal(mod.getConfigSource().writable, false);
    assert.equal(mod.getConfigSource().path, undefined, "a programmatic source has no write target");

    const outcome = await mod.savePoolEdit("fast", ["p/prog", "p/prog2"]);
    assert.deepEqual(outcome, { ok: true, runtimeOnly: true });
    assert.deepEqual(mod.getPools().fast, ["p/prog", "p/prog2"]);
    assert.deepEqual(
      readJson(file),
      { pools: { slow: ["p/onfile"] } },
      "the on-disk document is untouched by a runtime-only edit",
    );
  });
});

describe("authenticated membership", () => {
  it("E23: an entry that resolves but is not listed is unavailable", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/ghost", "p/a"] } });
    const models = modelsFrom({ listed: ["p/a"], resolvable: ["p/ghost", "p/a"] });

    const picked = await handlers.before_subagent_spawn(ROUTE_EV, subCtx(models));
    assert.equal(picked.model, "p/a");

    const report = mod.diagnosePools(models);
    const role = report.roles.find((r) => r.role === "slow");
    assert.equal(role.entries[0].eligible, false);
    assert.match(role.entries[0].reason, /not authenticated/);
    assert.equal(role.entries[1].eligible, true);
  });

  it("E24: a readable but empty registry makes every entry unavailable", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });
    const models = modelsFrom({ listed: [], resolvable: ["p/a"] });

    const picked = await handlers.before_subagent_spawn(ROUTE_EV, subCtx(models));
    assert.equal(picked, undefined);

    const report = mod.diagnosePools(models);
    assert.equal(report.registryReadable, true);
    assert.equal(report.roles[0].entries[0].eligible, false);
  });

  it("E25: a missing or throwing registry fails open and reports unreadable", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a"] } });

    const missing = await handlers.before_subagent_spawn(ROUTE_EV, subCtx(undefined));
    assert.equal(missing, undefined);
    assert.equal(mod.diagnosePools(undefined).registryReadable, false);

    const throwing = modelsFrom({ listed: ["p/a"], listThrows: true });
    const thrown = await handlers.before_subagent_spawn(ROUTE_EV, subCtx(throwing));
    assert.equal(thrown, undefined);
    assert.equal(mod.diagnosePools(throwing).registryReadable, false);
  });

  it("E26: strict hard-blocks only when the registry is readable and empty of matches", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/gone"] }, strict: ["slow"] });

    const blocked = await handlers.before_subagent_spawn(
      ROUTE_EV,
      subCtx(modelsFrom({ listed: ["p/other"] })),
    );
    assert.deepEqual(blocked, {
      block: true,
      reason: "model-pool: no authenticated model available for role @slow",
    });

    const unreadable = await handlers.before_subagent_spawn(ROUTE_EV, subCtx(undefined));
    assert.equal(unreadable, undefined);
  });

  it("E27: diagnosePools eligibility matches what the router picks", async () => {
    const { pi, handlers } = makeHarness();
    mod.default(pi, { pools: { slow: ["p/a", "p/ghost", "p/b"] } });
    const models = modelsFrom({ listed: ["p/a", "p/b"], resolvable: ["p/a", "p/ghost", "p/b"] });

    const report = mod.diagnosePools(models);
    assert.deepEqual(report.roles[0].entries.map((e) => e.eligible), [true, false, true]);

    const first = await handlers.before_subagent_spawn(ROUTE_EV, subCtx(models));
    const second = await handlers.before_subagent_spawn(ROUTE_EV, subCtx(models));
    assert.equal(first.model, "p/a");
    assert.equal(second.model, "p/b");
  });
});
