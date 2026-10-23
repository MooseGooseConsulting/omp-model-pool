// End-to-end rotation proof: each dispatch runs in its own OS process, exactly
// like sequential `omp -p` launches. With persistence on, the cycle continues;
// with it off, every process restarts at slot 0. The concurrency case runs the
// processes simultaneously so the shared state file's lock is contended for
// real (an in-process Promise.all cannot do that: acquire, read-modify-write
// and release are synchronous, so the first caller finishes before the second
// starts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const helper = path.join(here, "helpers", "dispatch-once.mjs");

function runOnce(stateFile, models, persist, iterations = 1) {
  const out = execFileSync(
    process.execPath,
    [helper, stateFile, "slow", models.join(","), persist ? "on" : "off", String(iterations)],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(out.trim());
}

function runAsync(stateFile, models, persist, iterations = 1) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [helper, stateFile, "slow", models.join(","), persist ? "on" : "off", String(iterations)],
      { cwd: root, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.trim()))),
    );
  });
}

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-xp-"));
  return { dir, file: path.join(dir, "state.json"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("cross-process rotation (separate OS processes)", () => {
  it("continues 0→1→0 across three node processes when persistence is on", () => {
    const { file, cleanup } = tmpStateFile();
    try {
      const models = ["p/a", "p/b"];
      const runs = [0, 1, 2].map(() => runOnce(file, models, true));
      assert.deepEqual(runs.map((r) => r.model), ["p/a", "p/b", "p/a"]);
      assert.equal(new Set(runs.map((r) => r.pid)).size, 3, "each run must be a distinct process");
      // Stored modulo the pool length (2): three picks land on 1.
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 1);
    } finally {
      cleanup();
    }
  });

  it("restarts at slot 0 in every process when persistence is off", () => {
    const { file, cleanup } = tmpStateFile();
    try {
      const models = ["p/a", "p/b"];
      const picks = [0, 1, 2].map(() => runOnce(file, models, false).model);
      assert.deepEqual(picks, ["p/a", "p/a", "p/a"]);
      assert.equal(fs.existsSync(file), false);
    } finally {
      cleanup();
    }
  });

  it("serializes four concurrent processes: 20 picks land 5 times on each of 4 slots", async () => {
    const { file, cleanup } = tmpStateFile();
    try {
      const models = ["p/a", "p/b", "p/c", "p/d"];
      const runs = await Promise.all(models.map(() => runAsync(file, models, true, 5)));
      const picks = runs.flatMap((r) => r.picks);
      assert.equal(picks.length, 20);
      for (const model of models) {
        assert.equal(picks.filter((p) => p === model).length, 5, `${model} drawn exactly 5 times`);
      }
      // Stored modulo the pool length (4): 20 picks wrap back to 0.
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 0);
    } finally {
      cleanup();
    }
  });

  it("reclaims a lock whose owner process is gone", async () => {
    const { file, cleanup } = tmpStateFile();
    try {
      const exited = spawnSync(process.execPath, ["-e", "0"]);
      const deadPid = exited.pid;
      const lock = `${file}.lock`;
      fs.mkdirSync(lock, { recursive: true });
      fs.writeFileSync(path.join(lock, "owner"), `${deadPid}.${Date.now()}.test`);
      const models = ["p/a", "p/b"];
      assert.equal(runOnce(file, models, true).model, "p/a");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 1);
      assert.equal(fs.existsSync(lock), false, "reclaimed lock is released");
    } finally {
      cleanup();
    }
  });

  it("never steals a lock held by a live process", async () => {
    const { file, cleanup } = tmpStateFile();
    let holder;
    try {
      const lock = `${file}.lock`;
      fs.mkdirSync(lock, { recursive: true });
      holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "ignore" });
      fs.writeFileSync(path.join(lock, "owner"), `${holder.pid}.${Date.now()}.holdup`);
      const models = ["p/a", "p/b"];
      // Times out waiting, then fails open to the in-memory counter.
      const run = runOnce(file, models, true);
      assert.equal(run.model, "p/a");
      assert.equal(fs.existsSync(lock), true, "live holder's lock is left in place");
      assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8").split(".")[0], String(holder.pid));
    } finally {
      if (holder) holder.kill();
      cleanup();
    }
  });
});
