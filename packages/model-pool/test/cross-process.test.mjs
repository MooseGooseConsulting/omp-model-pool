// End-to-end rotation proof: each dispatch runs in its own OS process, exactly
// like sequential `omp -p` launches. With persistence on, the cycle continues;
// with it off, every process restarts at slot 0. The concurrency case runs the
// processes simultaneously so the shared state file's lock is contended for
// real (an in-process Promise.all cannot do that: acquire, read-modify-write
// and release are synchronous, so the first caller finishes before the second
// starts). The gated startup cases go further: the first child is held inside
// its own main-session pick — lock still held — while a second child actually
// contends for the file, observed over IPC instead of sleeps.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The spawn's first model: the chain is an array once the pool has alternatives. */
const headOf = (model) => (Array.isArray(model) ? model[0] : model);


const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const helper = path.join(here, "helpers", "dispatch-once.mjs");

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-xp-"));
  return { dir, file: path.join(dir, "state.json"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

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

// How long a gated child may take to report before the test declares failure.
// The happy path never waits this out: every step is synchronized by a real
// IPC message, so the ceiling only bounds a hung or crashed child.
const GATED_WAIT_MS = 15_000;

const SEED_STATE = `${JSON.stringify({ version: 2, counters: { slow: 0 } })}\n`;

function stderrNote(stderr) {
  const note = stderr.trim();
  return note.length > 0 ? `: ${note}` : "";
}

/**
 * Spawn one gated child with its own IPC channel and return a handle whose
 * steps synchronize on the messages the child actually sends — never on sleeps.
 * A wait rejects when the child exits, dies, times out or sends an unexpected
 * message (each with the captured stderr), so contention that silently never
 * happens fails the test instead of passing it.
 */
function spawnGated(stateFile, models) {
  const child = spawn(
    process.execPath,
    [helper, stateFile, "slow", models.join(","), "on", "1", "--main-rotation-gated"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = [];
  const inbox = [];
  let exitState = null;
  const fail = (why) => {
    const error = new Error(`${why}${stderrNote(stderr)}`);
    for (const w of pending.splice(0)) w.reject(error);
    return error;
  };
  const serve = () => {
    for (const w of pending.splice(0)) w();
  };
  child.on("message", (message) => {
    inbox.push(message);
    serve();
  });
  child.on("error", (err) => fail(`gated child failed to spawn: ${err.message}`));
  child.on("exit", (code, signal) => {
    exitState = { code, signal };
    fail(`gated child exited (code ${code}, signal ${signal}) before the test finished`);
  });
  const wait = (type) => new Promise((resolve, reject) => {
    let timer;
    const next = () => {
      const message = inbox.shift();
      if (message === undefined) {
        timer = setTimeout(() => {
          pending.splice(pending.indexOf(next), 1);
          reject(new Error(`timed out after ${GATED_WAIT_MS}ms waiting for ${JSON.stringify(type)} from the gated child`));
        }, GATED_WAIT_MS);
        pending.push(() => {
          clearTimeout(timer);
          next();
        });
        return;
      }
      clearTimeout(timer);
      if (message === null || typeof message !== "object" || message.type !== type) {
        reject(new Error(`gated child sent ${JSON.stringify(message)} while the test waited for ${JSON.stringify(type)}`));
        return;
      }
      resolve(message);
    };
    next();
  });
  const release = (accept) => {
    if (child.connected !== true) {
      throw new Error(`gated child's IPC channel is closed; cannot release its pick with accept=${accept}`);
    }
    child.send({ type: "release", accept });
  };
  const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const report = async () => {
    const { code } = await exitPromise;
    if (code !== 0) throw new Error(`gated child exited with code ${code}${stderrNote(stderr)}`);
    const lines = stdout.trim().split("\n").filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) throw new Error(`gated child printed no report${stderrNote(stderr)}`);
    let parsed;
    try {
      parsed = JSON.parse(last);
    } catch (err) {
      throw new Error(`gated child report is not JSON (${err.message}): ${last}`);
    }
    if (
      parsed === null || typeof parsed !== "object" ||
      typeof parsed.pid !== "number" || typeof parsed.model !== "string" || !Array.isArray(parsed.picks)
    ) {
      throw new Error(`gated child report has an unexpected shape: ${last}`);
    }
    return parsed;
  };
  const kill = () => {
    if (exitState === null) child.kill();
  };
  // `wait` resolves the full typed message; assertions care about its model payload.
  const waitModel = async (type) => (await wait(type)).model;
  return { child, wait, waitModel, release, report, kill };
}

describe("cross-process rotation (separate OS processes)", () => {
  it("continues 0→1→0 across three node processes when persistence is on", () => {
    const { file, cleanup } = tmpStateFile();
    try {
      const models = ["p/a", "p/b"];
      const runs = [0, 1, 2].map(() => runOnce(file, models, true));
      assert.deepEqual(runs.map((r) => headOf(r.model)), ["p/a", "p/b", "p/a"]);
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
      const picks = [0, 1, 2].map(() => headOf(runOnce(file, models, false).model));
      assert.deepEqual(picks, ["p/a", "p/a", "p/a"]);
      assert.equal(fs.existsSync(file), false);
    } finally {
      cleanup();
    }
  });

  it("holds the state-file lock through a gated pick: the contender waits, then receives B", async () => {
    const { file, cleanup } = tmpStateFile();
    fs.writeFileSync(file, SEED_STATE);
    const one = spawnGated(file, ["p/a", "p/b"]);
    try {
      assert.equal(await one.waitModel("in-set-model"), "p/a", "child 1 reports its pending pick over IPC");
      const seeded = fs.readFileSync(file, "utf8");
      assert.equal(fs.existsSync(`${file}.lock`), true, "child 1 holds the state-file lock while the pick is pending");
      const two = spawnGated(file, ["p/a", "p/b"]);
      try {
        // Child 2 must be refused the lock child 1 still holds before anything
        // else happens: if the lock ever left child 1 early, child 2 would
        // acquire it and enter its own setModel instead.
        await two.wait("lock-contended");
        assert.equal(fs.readFileSync(file, "utf8"), seeded, "state bytes are unchanged while the pick is pending");
        one.release(true);
        const oneReport = await one.report();
        assert.equal(oneReport.model, "p/a", "child 1 starts on the accepted pick");
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 1, "child 1's acceptance is durable before child 2 proceeds");
        assert.equal(await two.waitModel("in-set-model"), "p/b", "child 2 receives B only after child 1 committed");
        two.release(true);
        const twoReport = await two.report();
        assert.equal(twoReport.model, "p/b", "child 2 starts on the next slot");
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 0, "final durable cursor after both picks");
        assert.equal(new Set([oneReport.pid, twoReport.pid]).size, 2, "both picks are distinct OS processes");
      } finally {
        two.kill();
      }
    } finally {
      one.kill();
      cleanup();
    }
  });

  it("holds the state-file lock through a gated pick: a refusal commits nothing, the contender still receives A", async () => {
    const { file, cleanup } = tmpStateFile();
    fs.writeFileSync(file, SEED_STATE);
    const one = spawnGated(file, ["p/a", "p/b"]);
    try {
      assert.equal(await one.waitModel("in-set-model"), "p/a", "child 1 reports its pending pick over IPC");
      const seeded = fs.readFileSync(file, "utf8");
      assert.equal(fs.existsSync(`${file}.lock`), true, "child 1 holds the state-file lock while the pick is pending");
      const two = spawnGated(file, ["p/a", "p/b"]);
      try {
        await two.wait("lock-contended");
        assert.equal(fs.readFileSync(file, "utf8"), seeded, "state bytes are unchanged while the pick is pending");
        one.release(false);
        const oneReport = await one.report();
        assert.equal(oneReport.model, "p/a", "child 1 attempted the pick the host refused");
        assert.equal(fs.readFileSync(file, "utf8"), seeded, "a refusal commits nothing to the state file");
        assert.equal(await two.waitModel("in-set-model"), "p/a", "child 2 receives A: the refused pick consumed nothing");
        two.release(true);
        const twoReport = await two.report();
        assert.equal(twoReport.model, "p/a", "child 2 starts on the slot the refusal left open");
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counters.slow, 1, "final durable cursor after the refusal and child 2's pick");
        assert.equal(new Set([oneReport.pid, twoReport.pid]).size, 2, "both picks are distinct OS processes");
      } finally {
        two.kill();
      }
    } finally {
      one.kill();
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
      assert.equal(headOf(run.model), "p/a");
      assert.equal(fs.existsSync(lock), true, "live holder's lock is left in place");
      assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8").split(".")[0], String(holder.pid));
    } finally {
      if (holder) holder.kill();
      cleanup();
    }
  });
});
