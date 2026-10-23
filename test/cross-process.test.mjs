// End-to-end rotation proof: each dispatch runs in its own OS process, exactly
// like sequential `omp -p` launches. With persistence on, the cycle continues;
// with it off, every process restarts at slot 0.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const helper = path.join(here, "helpers", "dispatch-once.mjs");

function runOnce(stateFile, models, persist) {
  const out = execFileSync(
    process.execPath,
    [helper, stateFile, "slow", models.join(","), persist ? "on" : "off"],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(out.trim());
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-xp-"));
  try {
    return fn(path.join(dir, "state.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("cross-process rotation (separate OS processes)", () => {
  it("continues 0→1→0 across three node processes when persistence is on", () => {
    withTmp((stateFile) => {
      const models = ["p/a", "p/b"];
      const runs = [0, 1, 2].map(() => runOnce(stateFile, models, true));
      assert.deepEqual(runs.map((r) => r.model), ["p/a", "p/b", "p/a"]);
      assert.equal(new Set(runs.map((r) => r.pid)).size, 3, "each run must be a distinct process");
      assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).counters.slow, 3);
    });
  });

  it("restarts at slot 0 in every process when persistence is off", () => {
    withTmp((stateFile) => {
      const models = ["p/a", "p/b"];
      const picks = [0, 1, 2].map(() => runOnce(stateFile, models, false).model);
      assert.deepEqual(picks, ["p/a", "p/a", "p/a"]);
      assert.equal(fs.existsSync(stateFile), false);
    });
  });
});
