// The live suite's cursor oracle, exercised offline.
//
// The reviewed failure mode: OMP accepts a startup pick (it records a
// `model_change` entry) and then dies before inference, so the transcript has
// no assistant turn at all. Judging "accepted" from transcripts that carry an
// assistant message would call that "nothing consumed" while the durable cursor
// had correctly advanced. These cases pin the real parser plus the decision, so
// the live run cannot regress back to that reading.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { acceptedEvidence, cursorExpectation } from "./live/free-routes.mjs";
import { readTranscript } from "./live/omp-runner.mjs";

const EXPECTED = "smoke-openrouter/liquid/lfm-3-1.7b:free";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-oracle-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a JSONL transcript from the given entries and return its path. */
function writeTranscript(name, entries) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return file;
}

const header = { type: "session", id: "s", timestamp: new Date().toISOString() };

describe("live cursor oracle", () => {
  it("treats a model change without any assistant turn as an accepted pick", () => {
    // Exactly the reviewed scenario: the change is recorded, then the run dies.
    const file = writeTranscript("crash.jsonl", [
      header,
      { type: "model_change", model: EXPECTED },
      { type: "message", message: { role: "user", content: "Reply with exactly: OK" } },
    ]);
    const parsed = readTranscript(file);
    assert.deepEqual(parsed.modelsApplied, [EXPECTED]);
    assert.deepEqual(parsed.assistantModels, [], "no assistant turn exists");
    assert.equal(
      acceptedEvidence([parsed], EXPECTED),
      true,
      "the decision must consider every fresh transcript, not only those with an assistant turn",
    );

    const decision = cursorExpectation({
      accepted: parsed.modelsApplied.includes(EXPECTED),
      hadEvidence: true,
      previous: 0,
      poolLength: 2,
    });
    assert.equal(decision.status, "check");
    assert.equal(decision.expected, 1, "the committed slot advanced the cursor");
  });

  it("keeps the cursor when a transcript exists but records no model change", () => {
    const file = writeTranscript("no-change.jsonl", [
      header,
      { type: "message", message: { role: "user", content: "Reply with exactly: OK" } },
    ]);
    const parsed = readTranscript(file);
    assert.deepEqual(parsed.modelsApplied, []);

    const decision = cursorExpectation({
      accepted: parsed.modelsApplied.includes(EXPECTED),
      hadEvidence: true,
      previous: 1,
      poolLength: 2,
    });
    assert.equal(decision.status, "check");
    assert.equal(decision.expected, 1, "nothing was consumed");
  });

  it("skips the judgement when the run wrote no transcript at all", () => {
    const decision = cursorExpectation({
      accepted: false,
      hadEvidence: false,
      previous: 1,
      poolLength: 2,
    });
    assert.equal(decision.status, "skip", "unknown evidence is never a pass or a failure");
    assert.equal(decision.expected, 1);
  });

  it("wraps the cursor at the pool length", () => {
    const decision = cursorExpectation({ accepted: true, hadEvidence: true, previous: 1, poolLength: 2 });
    assert.equal(decision.status, "check");
    assert.equal(decision.expected, 0);
  });

});
