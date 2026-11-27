// Deterministic real-OMP E2E: loopback-fixture cases, no credentials.
//
// Every step runs a REAL `omp` process against a REAL loopback HTTP server
// (test/e2e/loopback.mjs). There is no fake host and no fallback: a missing
// binary, a timeout, a CLI error, a malformed transcript, a model mismatch, a
// wrong cursor, a missing child transcript or an unexpected wire model all
// FAIL the suite. The single legitimate skip is a missing OMP binary off-CI,
// where nothing is installed; a pinned OMP_BIN that cannot execute fails
// everywhere.
//
// Files and state live entirely under per-case temp roots created by the
// shared harness (test/live/isolated-env.mjs); roots are removed in every
// case's `finally` and the loopback server is closed in the outer `finally`.
// Nothing credential-like (headers, env values beyond the fixture's dummy
// key, raw request errors) is ever printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIsolatedEnv,
  diffManifests,
  hashOwnerConfig,
  sweepAbandonedRoots,
  writeRunManifest,
} from "../live/isolated-env.mjs";
import { findSessionFiles, readTranscript, runOmp } from "../live/omp-runner.mjs";
import {
  FIXTURE_PROVIDER,
  MISTRAL_FIXTURE_API_KEY,
  startLoopbackFixture,
  writeModelsYaml,
  writeScoutAgent,
} from "./loopback.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
/** The pool extension lives in its own package; the integration suite stays at the root. */
const POOL_PACKAGE = path.join(repoRoot, "packages", "model-pool");
const MISTRAL_PACKAGE = path.join(repoRoot, "packages", "mistral-live");
/** One OMP process may not outlive this; the loopback answers in milliseconds. */
const PROCESS_TIMEOUT_MS = 20_000;

const PROVIDER = FIXTURE_PROVIDER;
const PIN_SELECTOR = `${PROVIDER}/pin`;
const MAIN_POOL = [`${PROVIDER}/b:high`, `${PROVIDER}/a`];
const SLOW_POOL = [`${PROVIDER}/slow-a:high`, `${PROVIDER}/slow-b`];
/**
 * Three-entry slow pool for the bounded-chain coverage. The third entry reuses
 * the main pool's undecorated `a` row (never `pin`, which is the parent's own
 * model), so a chain that oversteps its cap is caught by a served wire request
 * for a model that should have been unreachable instead of by a hang.
 */
const SLOW_POOL_THREE = [`${PROVIDER}/slow-a:high`, `${PROVIDER}/slow-b`, `${PROVIDER}/a`];
const PROMPT = "Reply with exactly: OK";
const DELEGATE_PROMPT = "E2E_DELEGATE";

const results = [];
let failures = 0;
let skips = 0;

function record(name, status, detail = "") {
  const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  results.push({ name, status, detail });
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (status === "fail") failures += 1;
  if (status === "skip") skips += 1;
}

/** Thrown by `expect` to fail the current step; the case wrapper records it. */
class StepFailure extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`);
    this.step = step;
    this.detail = detail;
  }
}

function expect(ok, step, detail = "") {
  if (!ok) throw new StepFailure(step, detail);
  record(step, "pass", detail);
}

function detailOf(err) {
  return err instanceof StepFailure ? err.detail : err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Isolation: every case owns a temp root that no failure path can leak.
// ---------------------------------------------------------------------------

const liveRoots = new Set();

/** Per-root wiring: pool config, extra overlay YAML, provider env, and the proxy guard. */
function caseOptions(poolConfig, { overlayExtra = [], providerEnv = {} } = {}) {
  return { poolConfig, overlayExtra, providerEnv };
}

async function inIsolatedRoot(label, options, caseFn) {
  // A case may force provider failures; they must never leak into the next one.
  fixture.resetFailures();
  let isolated;
  try {
    isolated = createIsolatedEnv({
      poolConfig: options.poolConfig,
      repoRoot: POOL_PACKAGE,
      label,
      providerEnv: rootEnv(options.providerEnv),
      overlayExtra: options.overlayExtra,
    });
  } catch (err) {
    record(`${label}: isolated environment`, "fail", detailOf(err));
    return;
  }
  liveRoots.add(isolated);
  writeManifest(isolated, options, "start");
  try {
    await caseFn(isolated);
  } catch (err) {
    if (err instanceof StepFailure) {
      record(err.step, "fail", err.detail);
    } else {
      record(`${label}: case crashed`, "fail", detailOf(err));
    }
  } finally {
    writeManifest(isolated, options, "complete");
    const removed = await isolated.cleanup();
    if (removed) liveRoots.delete(isolated);
    record(
      `${label}: temp root removed`,
      removed ? "pass" : "fail",
      removed ? "" : `${isolated.root} survived cleanup; report this root when triaging`,
    );
  }
}

/** Every root routes ambient egress at the fixture; only the fixture is reachable. */
function rootEnv(extra) {
  return {
    HTTP_PROXY: fixture === undefined ? "http://127.0.0.1:9" : fixture.url,
    HTTPS_PROXY: fixture === undefined ? "http://127.0.0.1:9" : fixture.url,
    NO_PROXY: "127.0.0.1",
    ...extra,
  };
}

/** Secret-free in-root run records, kept even when the case aborts midway. */
function writeManifest(isolated, options, phase) {
  try {
    writeRunManifest(isolated, {
      label: isolated.label,
      phase,
      ompArgs: isolated.ompArgs,
      poolConfig: options.poolConfig,
    });
  } catch (err) {
    record(`${isolated.label}: run manifest write`, "fail", detailOf(err));
  }
}

// ---------------------------------------------------------------------------
// OMP process + transcript helpers.
// ---------------------------------------------------------------------------

async function spawnOmp(isolated, args, step) {
  const res = await runOmp(args, { cwd: isolated.workDir, env: isolated.env, timeoutMs: PROCESS_TIMEOUT_MS });
  if (res.timedOut) {
    throw new StepFailure(`${step}: omp process completed`, `timed out after ${PROCESS_TIMEOUT_MS / 1000}s`);
  }
  if (res.code === null) {
    throw new StepFailure(`${step}: omp process completed`, `the OMP binary could not be executed (${path.basename(res.bin)})`);
  }
  if (res.code !== 0) {
    throw new StepFailure(`${step}: omp process completed`, `exit code ${res.code}`);
  }
  return res;
}

/**
 * Replace the exact `--tools <value>` pair in the harness baseline with a new
 * toolset, so exactly one `--tools` value is ever present (never a second
 * pair, never `--no-tools`).
 */
function withToolsValue(ompArgs, tools) {
  const cut = ompArgs.indexOf("--tools");
  const head = cut === -1 ? ompArgs : ompArgs.slice(0, cut);
  const tail = cut === -1 ? [] : ompArgs.slice(cut + 2);
  return [...head, "--tools", tools, ...tail];
}

function sessionPaths(isolated) {
  return findSessionFiles(isolated.sessionDir).map((s) => s.file);
}

/** Files that appeared between two path snapshots — by identity, never mtime. */
function newTranscripts(beforeSet, isolated) {
  return sessionPaths(isolated).filter((f) => !beforeSet.has(f));
}

function readStateCounters(file) {
  if (!existsSync(file)) return undefined;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  if (doc.version !== 2) return undefined;
  const counters = doc.counters;
  if (counters === null || typeof counters !== "object" || Array.isArray(counters)) return undefined;
  return counters;
}

function readCursor(file, role) {
  const counters = readStateCounters(file);
  if (counters === undefined) return undefined;
  const value = counters[role];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Flatten OMP's string-or-blocks message content to text. */
function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part !== null && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function transcriptEntries(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      // Malformed bodies fail the header checks below; skip the line.
      continue;
    }
    if (entry !== null && typeof entry === "object") out.push(entry);
  }
  return out;
}

function identityOf(message) {
  if (typeof message.model !== "string") return undefined;
  return typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model;
}

/** Assistant turns as `{ identity, content }`, in order. */
function assistantTurns(file) {
  return transcriptEntries(file)
    .filter((e) => e.type === "message" && e.message !== null && typeof e.message === "object" && e.message.role === "assistant")
    .map((e) => ({ identity: identityOf(e.message), content: messageText(e.message.content).trim() }));
}

/** Tool-result message contents, in order. The transcript role is camelCase
 * `toolResult` (the wire format uses `"tool"`); accept both spellings so a
 * newer host that relaxes the casing still parses. */
function toolResultTexts(file) {
  return transcriptEntries(file)
    .filter((e) => e.type === "message" && e.message !== null && typeof e.message === "object")
    .filter((e) => e.message.role === "toolResult" || e.message.role === "tool")
    .map((e) => messageText(e.message.content));
}

/** Any completed task tool result, regardless of the subagent instance name. */
const TASK_RESULT_DONE = /<task-result id="[^"]+" agent="[^"]+" status="completed"/;
const TASK_OUTPUT_OK = /<output>\s*OK\s*<\/output>/;
const STRICT_BLOCK_REASON = "no authenticated model available for role @slow";

// ---------------------------------------------------------------------------
// Wire capture helpers.
// ---------------------------------------------------------------------------

/**
 * Conversation-turn requests: everything a real tool surface rode on.
 * OMP's thinking-ladder capability probes run tool-less ("17x23" style
 * single-message bodies), so `tools.length > 0` separates the conversation
 * the session ran from the host's internal probing.
 */
function turnRequests(window) {
  return window.filter((c) => Array.isArray(c.tools) && c.tools.length > 0);
}

function capturesSince(index) {
  return fixture.captures.slice(index);
}

function describeCaptures(window) {
  return window
    .map((c) => {
      const effort = c.reasoningEffort !== undefined ? `@effort=${String(c.reasoningEffort)}` : "";
      const tools = c.tools.length > 0 ? ` [${c.tools.join(",")}]` : "";
      // Injected fixture failures are part of the story a failing detail tells.
      const outcome = c.outcome === "error" ? ` !${String(c.status)}` : "";
      return `${c.model}${effort}${tools}${outcome}`;
    })
    .join("; ");
}

// ---------------------------------------------------------------------------
// Case 1 — fresh rotation over the main pool, then resume keeps the model.
// ---------------------------------------------------------------------------

async function caseRotation() {
  const poolConfig = { default: MAIN_POOL, persistCounters: true };
  await inIsolatedRoot("case-1 rotation", caseOptions(poolConfig), async (isolated) => {
    writeModelsYaml(isolated.agentDir, fixture.port);

    let run2File;
    for (const [runNo, expectedId] of [[1, "b"], [2, "a"]]) {
      const step = `case 1 run ${runNo}`;
      const before = new Set(sessionPaths(isolated));
      const captureStart = fixture.captures.length;
      await spawnOmp(isolated, [...isolated.ompArgs, "--model", PIN_SELECTOR, "--thinking", "low", "-p", PROMPT], step);

      const fresh = newTranscripts(before, isolated);
      expect(fresh.length === 1, `${step}: exactly one new transcript`, `${fresh.length} new: ${fresh.join(", ")}`);
      if (runNo === 2) run2File = fresh[0];
      const transcript = readTranscript(fresh[0]);
      expect(transcript.header !== undefined, `${step}: transcript has a session header`, path.basename(fresh[0]));
      expect(
        transcript.assistantModels.length === 1 && transcript.assistantModels[0] === `${PROVIDER}/${expectedId}`,
        `${step}: assistant ran ${PROVIDER}/${expectedId}`,
        `identities: ${transcript.assistantModels.join(", ") || "(none)"}`,
      );
      expect(transcript.userTurns === 1, `${step}: exactly one user turn`, String(transcript.userTurns));
      expect(
        transcript.modelsApplied.includes(`${PROVIDER}/${expectedId}`),
        `${step}: model change applied`,
        transcript.modelsApplied.join(", ") || "(none)",
      );

      const turns = turnRequests(capturesSince(captureStart));
      expect(turns.length === 1, `${step}: exactly one conversation wire request`, describeCaptures(turns));
      expect(turns.length === 1 && turns[0].model === expectedId, `${step}: wire model is ${expectedId}`, describeCaptures(turns));
      if (expectedId === "b") {
        expect(
          turns.length === 1 && turns[0].reasoningEffort === "high",
          `${step}: pool slot b:high requested reasoning_effort high`,
          `wire effort: ${String(turns[0]?.reasoningEffort)}`,
        );
      } else {
        expect(
          turns.length === 1 && turns[0].reasoningEffort !== "high",
          `${step}: slot a (no suffix) never requested high`,
          `wire effort: ${String(turns[0]?.reasoningEffort)}`,
        );
      }

      const expectedCursor = runNo % MAIN_POOL.length;
      expect(
        readCursor(isolated.stateFile, "default") === expectedCursor,
        `${step}: durable cursor is ${expectedCursor}`,
        `state file cursor: ${String(readCursor(isolated.stateFile, "default"))}`,
      );
    }

    // Resume the second exact file with no model or effort pin: the loaded
    // session keeps pool-fixture/a, consumes no slot, cursor stays 0.
    expect(
      run2File !== undefined,
      "case 1 resume: second transcript located",
      `${sessionPaths(isolated).length} transcripts in ${isolated.sessionDir}`,
    );
    if (run2File === undefined) return;

    const resumeBefore = readTranscript(run2File);
    const filesBefore = new Set(sessionPaths(isolated));
    const captureStart = fixture.captures.length;
    await spawnOmp(isolated, [...isolated.ompArgs, "--resume", run2File, "-p", PROMPT], "case 1 resume");
    expect(newTranscripts(filesBefore, isolated).length === 0, "case 1 resume: no new transcript file", "resume appends to the resumed transcript");

    const resumeAfter = readTranscript(run2File);
    const addedUserTurns = resumeAfter.userTurns - resumeBefore.userTurns;
    const addedModels = resumeAfter.assistantModels.slice(resumeBefore.assistantModels.length);
    expect(addedUserTurns === 1, "case 1 resume: one new user turn", `user turns ${resumeBefore.userTurns} -> ${resumeAfter.userTurns}`);
    expect(
      addedModels.length === 1 && addedModels[0] === `${PROVIDER}/a`,
      "case 1 resume: one new assistant turn on pool-fixture/a",
      `identity delta: ${addedModels.join(", ") || "(none)"}`,
    );

    const resumeTurns = turnRequests(capturesSince(captureStart));
    expect(
      resumeTurns.length === 1 && resumeTurns[0].model === "a",
      "case 1 resume: exactly one matching wire request",
      describeCaptures(resumeTurns),
    );
    expect(
      resumeTurns[0]?.reasoningEffort !== "high",
      "case 1 resume: resumed turn keeps the session effort (never high)",
      `wire effort: ${String(resumeTurns[0]?.reasoningEffort)}`,
    );
    expect(
      readCursor(isolated.stateFile, "default") === 0,
      "case 1 resume: cursor still 0",
      `state cursor: ${String(readCursor(isolated.stateFile, "default"))}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Case 1b — the DEFAULT mode: persistCounters is off.
//
// In-memory counters are module state, so they are shared by every session in
// one process and lost when that process exits. Two fresh OS processes must
// therefore both start at slot 0, and neither may leave a state file behind.
// Every other real-host case enables persistence, so without this one the
// shipped default was only ever covered by the fake host.
// ---------------------------------------------------------------------------

async function caseInMemoryRotation() {
  const poolConfig = { default: MAIN_POOL };
  await inIsolatedRoot("case-1b in-memory", caseOptions(poolConfig), async (isolated) => {
    writeModelsYaml(isolated.agentDir, fixture.port);

    for (const runNo of [1, 2]) {
      const step = `case 1b run ${runNo}`;
      const before = new Set(sessionPaths(isolated));
      const captureStart = fixture.captures.length;
      await spawnOmp(isolated, [...isolated.ompArgs, "--model", PIN_SELECTOR, "-p", PROMPT], step);

      const fresh = newTranscripts(before, isolated);
      expect(fresh.length === 1, `${step}: exactly one new transcript`, `${fresh.length} new: ${fresh.join(", ")}`);
      const transcript = readTranscript(fresh[0]);
      expect(
        transcript.assistantModels.length === 1 && transcript.assistantModels[0] === `${PROVIDER}/b`,
        `${step}: a fresh process starts at slot 0 (${PROVIDER}/b)`,
        `identities: ${transcript.assistantModels.join(", ") || "(none)"}`,
      );
      const turns = turnRequests(capturesSince(captureStart));
      expect(turns.length === 1, `${step}: exactly one conversation wire request`, describeCaptures(turns));
      expect(turns.length === 1 && turns[0].model === "b", `${step}: wire model is b`, describeCaptures(turns));
      expect(
        turns.length === 1 && turns[0].reasoningEffort === "high",
        `${step}: slot b:high still requests reasoning_effort high in memory mode`,
        `wire effort: ${String(turns[0]?.reasoningEffort)}`,
      );
      expect(
        !existsSync(isolated.stateFile),
        `${step}: persistence off writes no state file`,
        isolated.stateFile,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Case 2d — a failing first model must fail over to the next pool entry.
//
// Accepting a returned model LIST is not failover: this case forces the pinned
// host to hit an error on the chosen slot and proves the child completes on the
// following entry, with the chain supplied by the pool and not by static retry
// configuration.
// ---------------------------------------------------------------------------

/**
 * Re-enable the host's model fallback for one case, and only for that case.
 *
 * The shared overlay disables retry so every other case stays deterministic.
 * `maxRetries` is 0 deliberately: `enabled`/`modelFallback` must still drive
 * the real chain consult immediately, but the host's own same-model retry
 * loops must not stack extra attempts on top of the pool's failover — with
 * the loopback answering in milliseconds that is what keeps the whole chain
 * inside the 20-second per-process ceiling (PROCESS_TIMEOUT_MS is not raised).
 * The replacement is asserted: if the generated block changes shape, this case
 * fails loudly instead of silently testing nothing.
 */
function enableModelFallback(overlayFile, label) {
  const before = readFileSync(overlayFile, "utf8");
  const after = before.replace(
    "retry:\n  enabled: false\n  modelFallback: false\n  fallbackChains: {}",
    "retry:\n  enabled: true\n  modelFallback: true\n  fallbackOn: any\n  maxRetries: 0\n  baseDelayMs: 50",
  );
  expect(
    after !== before,
    `${label}: overlay retry block patched`,
    "retry block replaced with modelFallback enabled",
  );
  writeFileSync(overlayFile, after, "utf8");
}

async function caseFailoverChain() {
  const poolConfig = { slow: SLOW_POOL, enableMainSessionRotation: false, persistCounters: true };
  await inIsolatedRoot(
    "case-2d failover",
    caseOptions(poolConfig, { overlayExtra: ["modelRoles:", "  slow: " + PIN_SELECTOR] }),
    async (isolated) => {
      writeModelsYaml(isolated.agentDir, fixture.port);
      writeScoutAgent(isolated.agentDir);
      enableModelFallback(isolated.overlayFile, "case 2d");
      // Every attempt on the first pool entry fails: only a failover to
      // slow-b can produce a completed child. maxFallbacks stays unset, so
      // the extension default (1) bounds the chain — which the two-entry pool
      // satisfies with slow-b. Forced-failure counts are asserted as "one or
      // more": the host's own per-model retry count is its business, not this
      // suite's claim.
      fixture.failModel("slow-a", { status: 500 });

      const { before, captureStart } = await runDelegationParent(
        isolated,
        [{ name: "pool-review", agent: "reviewer" }],
        "case 2d failover",
      );
      const fresh = newTranscripts(before, isolated);
      const children = fresh.filter((f) => readTranscript(f).header?.parentSession !== undefined);
      const parents = fresh.filter((f) => readTranscript(f).header?.parentSession === undefined);
      expect(children.length === 1, "case 2d: exactly one new child transcript", String(children.length));
      expect(parents.length === 1, "case 2d: exactly one new parent transcript", String(parents.length));
      if (children.length !== 1 || parents.length !== 1) return;

      const child = readTranscript(children[0]);
      expect(
        child.header.parentSession === parents[0],
        "case 2d: child parentSession points at the new parent",
        `${path.basename(String(child.header.parentSession))} vs parent ${path.basename(parents[0])}`,
      );
      // A completed failover records the forced error entries too, so the
      // history need not be uniform — but its LAST identity must be the
      // successful fallback model. The ordered wire window below already
      // proves exactly one success and no later child model, so a passing
      // error-bearing entry cannot sneak past this assertion.
      const lastChildModel = child.assistantModels.at(-1);
      expect(
        child.assistantModels.length > 0 && lastChildModel === `${PROVIDER}/slow-b`,
        "case 2d: child history ends on the successful fallback model",
        child.assistantModels.join(", ") || "(none)",
      );

      // The parent always rides `pin` (main-session rotation is off) and the
      // host's thinking-ladder probes are tool-less, so every non-pin
      // conversation request in the window is the child's attempt chain.
      const attempts = turnRequests(capturesSince(captureStart)).filter((c) => c.model !== "pin");
      const forced = attempts.filter((c) => c.model === "slow-a" && c.outcome === "error" && c.status === 500);
      expect(
        forced.length >= 1,
        "case 2d: one or more forced slow-a failures",
        `${forced.length} forced failure(s); window: ${describeCaptures(attempts)}`,
      );
      const served = attempts.filter((c) => c.model === "slow-b" && c.outcome === "ok");
      expect(
        served.length === 1,
        "case 2d: exactly one successful slow-b child request",
        describeCaptures(attempts),
      );
      const last = attempts.at(-1);
      expect(
        last !== undefined && last.model === "slow-b" && last.outcome === "ok",
        "case 2d: no later child model after the fallback success",
        describeCaptures(attempts),
      );

      // A model identity alone could be an error entry: require the task to have
      // actually completed with the expected output, like the rotation case does.
      const done = toolResultTexts(parents[0]).filter(
        (t) => TASK_RESULT_DONE.test(t) && TASK_OUTPUT_OK.test(t),
      );
      expect(done.length === 1, "case 2d: the delegated task completed", `${done.length} completed task-result envelope(s)`);
      const lastAssistant = assistantTurns(parents[0]).slice(-1)[0];
      expect(
        lastAssistant?.content === "OK",
        "case 2d: parent terminal OK",
        `last assistant content: ${JSON.stringify(lastAssistant?.content ?? null)}`,
      );
      expect(
        readCursor(isolated.stateFile, "slow") === 1,
        "case 2d: durable slow cursor is 1",
        `state cursor: ${String(readCursor(isolated.stateFile, "slow"))}`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Case 2e — bounded failover chains over a three-entry slow pool.
//
// Case 2d proves failover happens; this one proves the pool's `maxFallbacks`
// cap bounds it. The third entry reuses the main pool's undecorated `a` row, so
// a chain that oversteps its cap shows up as a served wire request for a model
// that should have been unreachable instead of as a hang. Each scenario gets
// its own isolated root, so `maxFallbacks` rides that root's
// OMP_MODEL_POOLS_JSON and the per-case failure reset still applies as before.
// ---------------------------------------------------------------------------

/** The slow-role overlay every bounded scenario shares. */
const BOUNDED_SLOW_OVERLAY = ["modelRoles:", `  slow: ${PIN_SELECTOR}`];

/**
 * One bounded-chain scenario: a parent that delegates once to the three-entry
 * slow pool with `maxFallbacks` (undefined = extension default) and every model
 * in `forced` failing every attempt with the injected status.
 *
 * Shared invariants, independent of the cap: exactly one parent and one child
 * transcript, the child's `parentSession` is the new parent file, the chain
 * starts at the picked slot, each forced model fails at least once (never an
 * exact count — the host's per-model retry budget is not this suite's claim),
 * the parent still finishes with a terminal OK, and the pick consumed exactly
 * one durable slot. Scenario-specific wire claims and the child's final model
 * identity come in via `assertWindow` and `childIdentity` (undefined when the
 * child is expected to fail and so has no successful identity to assert).
 */
async function runBoundedScenario({ label, maxFallbacks, forced, childIdentity, expectCompleted = true, assertWindow }) {
  const step = `case 2e ${label}`;
  const poolConfig = { slow: SLOW_POOL_THREE, enableMainSessionRotation: false, persistCounters: true };
  if (maxFallbacks !== undefined) poolConfig.maxFallbacks = maxFallbacks;
  await inIsolatedRoot(`case-2e bounded ${label}`, caseOptions(poolConfig, { overlayExtra: BOUNDED_SLOW_OVERLAY }), async (isolated) => {
    writeModelsYaml(isolated.agentDir, fixture.port);
    enableModelFallback(isolated.overlayFile, step);
    for (const model of forced) fixture.failModel(model, { status: 500 });

    const { before, captureStart } = await runDelegationParent(isolated, [{ name: "pool-review", agent: "reviewer" }], step);
    const fresh = newTranscripts(before, isolated);
    const parents = fresh.filter((f) => readTranscript(f).header?.parentSession === undefined);
    const children = fresh.filter((f) => readTranscript(f).header?.parentSession !== undefined);
    expect(parents.length === 1, `${step}: exactly one new parent transcript`, `${parents.length}: ${parents.join(", ")}`);
    if (parents.length !== 1) return;
    if (expectCompleted) {
      // A child that completes always leaves a transcript (established by the
      // delegation case); a child that fails on every model may legitimately
      // leave none, so only the failed-spawn scenario tolerates zero.
      expect(children.length === 1, `${step}: exactly one new child transcript`, `${children.length}: ${children.join(", ")}`);
    } else {
      expect(
        children.length <= 1,
        `${step}: at most one child transcript for the failed spawn`,
        `${children.length}: ${children.join(", ")}`,
      );
    }
    if (children.length === 1) {
      const child = readTranscript(children[0]);
      expect(
        child.header.parentSession === parents[0],
        `${step}: child parentSession points at the new parent`,
        `${path.basename(String(child.header.parentSession))} vs parent ${path.basename(parents[0])}`,
      );
      if (childIdentity !== undefined) {
        // Error entries may sit earlier in the history; only the LAST
        // identity must be the expected successful model.
        const lastChildModel = child.assistantModels.at(-1);
        expect(
          child.assistantModels.length > 0 && lastChildModel === `${PROVIDER}/${childIdentity}`,
          `${step}: child history ends on ${PROVIDER}/${childIdentity}`,
          child.assistantModels.join(", ") || "(none)",
        );
      }
    }

    // The parent always rides `pin` (main-session rotation is off) and the
    // host's thinking-ladder probes are tool-less, so every non-pin
    // conversation request in the window is the child's attempt chain.
    const attempts = turnRequests(capturesSince(captureStart)).filter((c) => c.model !== "pin");
    expect(attempts.length > 0, `${step}: the child reached the fixture`, "(no child wire request)");
    expect(
      attempts[0]?.model === "slow-a",
      `${step}: the chain started at the picked slot slow-a`,
      describeCaptures(attempts),
    );
    for (const model of forced) {
      const failures = attempts.filter((c) => c.model === model && c.outcome === "error" && c.status === 500);
      expect(
        failures.length >= 1,
        `${step}: one or more forced ${model} failures`,
        `${failures.length} forced failure(s); window: ${describeCaptures(attempts)}`,
      );
    }
    assertWindow(attempts, step);

    const done = toolResultTexts(parents[0]).filter((t) => TASK_RESULT_DONE.test(t) && TASK_OUTPUT_OK.test(t));
    expect(
      done.length === (expectCompleted ? 1 : 0),
      `${step}: ${expectCompleted ? "one completed task-result envelope" : "no completed task result without a fallback"}`,
      `${done.length} completed task-result envelope(s)`,
    );
    const lastAssistant = assistantTurns(parents[0]).slice(-1)[0];
    expect(
      lastAssistant?.content === "OK",
      `${step}: parent terminal OK`,
      `last assistant content: ${JSON.stringify(lastAssistant?.content ?? null)}`,
    );
    expect(
      readCursor(isolated.stateFile, "slow") === 1,
      `${step}: durable slow cursor is 1`,
      `state cursor: ${String(readCursor(isolated.stateFile, "slow"))}`,
    );
  });
}

async function caseBoundedChain() {
  // (a) Extension default (maxFallbacks unset → 1): after the picked slot
  // fails, exactly one fallback runs and the third entry is never attempted.
  await runBoundedScenario({
    label: "default cap",
    forced: ["slow-a"],
    childIdentity: "slow-b",
    assertWindow(attempts, step) {
      expect(
        attempts.every((c) => c.model === "slow-a" || c.model === "slow-b"),
        `${step}: the chain stayed inside the first two entries`,
        describeCaptures(attempts),
      );
      expect(
        !attempts.some((c) => c.model === "a"),
        `${step}: default maxFallbacks 1 never reaches the third entry`,
        describeCaptures(attempts),
      );
      const served = attempts.filter((c) => c.model === "slow-b" && c.outcome === "ok");
      expect(
        served.length === 1,
        `${step}: exactly one successful slow-b child request`,
        describeCaptures(attempts),
      );
      const last = attempts.at(-1);
      expect(
        last !== undefined && last.model === "slow-b" && last.outcome === "ok",
        `${step}: no child request after the fallback success`,
        describeCaptures(attempts),
      );
    },
  });

  // (b) maxFallbacks 0 restores the old single-model return: no second entry,
  // the child fails after the host's own retries, the parent still finishes,
  // and the failed pick consumed exactly one slot — not two.
  await runBoundedScenario({
    label: "cap 0",
    maxFallbacks: 0,
    forced: ["slow-a"],
    expectCompleted: false,
    assertWindow(attempts, step) {
      expect(
        attempts.every((c) => c.model === "slow-a" && c.outcome === "error"),
        `${step}: maxFallbacks 0 never reaches a second entry`,
        describeCaptures(attempts),
      );
    },
  });

  // (c) maxFallbacks 2: the chain crosses the injected failures on the first
  // two entries and finishes on the third.
  await runBoundedScenario({
    label: "cap 2",
    maxFallbacks: 2,
    forced: ["slow-a", "slow-b"],
    childIdentity: "a",
    assertWindow(attempts, step) {
      const served = attempts.filter((c) => c.model === "a" && c.outcome === "ok");
      expect(
        served.length === 1,
        `${step}: maxFallbacks 2 reached the third entry exactly once`,
        describeCaptures(attempts),
      );
      const last = attempts.at(-1);
      expect(
        last !== undefined && last.model === "a" && last.outcome === "ok",
        `${step}: no child request after the third entry`,
        describeCaptures(attempts),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Case 2 — role-keyed rotation through real delegation, incl. wraparound.
// ---------------------------------------------------------------------------

/** One parent run that delegates exactly `plan` times, then stops. */
async function runDelegationParent(isolated, plan, label) {
  fixture.setDelegationScript(plan);
  const before = new Set(sessionPaths(isolated));
  const captureStart = fixture.captures.length;
  const rejectionStart = fixture.rejections.length;
  await spawnOmp(
    isolated,
    [...withToolsValue(isolated.ompArgs, "task"), "--model", PIN_SELECTOR, "--thinking", "low", "-p", DELEGATE_PROMPT],
    label,
  );
  return { before, captureStart, rejectionStart };
}

/** True when the run window contains any wire attempt at the dead selector. */
function selectorAttempted(captures, rejections) {
  return (
    captures.some((c) => c.model.includes("does-not-exist")) ||
    rejections.some((r) => r.reason.includes("does-not-exist"))
  );
}

async function caseDelegation() {
  const poolConfig = { slow: SLOW_POOL, enableMainSessionRotation: false, persistCounters: true };
  await inIsolatedRoot(
    "case-2 delegation",
    caseOptions(poolConfig, { overlayExtra: ["modelRoles:", `  slow: ${PIN_SELECTOR}`] }),
    async (isolated) => {
      writeModelsYaml(isolated.agentDir, fixture.port);
      // Route the loopback scout on the slow role: the bundled scout carries
      // no @slow model, which would leave the middle wraparound spawn
      // unrotated. Same mechanism as `omp agents unpack`.
      writeScoutAgent(isolated.agentDir);

      // -- two single-spawn runs: slow[0] with the slot's effort, then slow[1]
      for (const [runNo, expectedId] of [[1, "slow-a"], [2, "slow-b"]]) {
        const label = `case 2 delegation run ${runNo}`;
        const { before, captureStart } = await runDelegationParent(isolated, [{ name: "pool-review", agent: "reviewer" }], label);

        const fresh = newTranscripts(before, isolated);
        const children = fresh.filter((f) => readTranscript(f).header?.parentSession !== undefined);
        const parents = fresh.filter((f) => readTranscript(f).header?.parentSession === undefined);
        expect(parents.length === 1, `${label}: exactly one new parent transcript`, `${parents.length}: ${parents.join(", ")}`);
        expect(children.length === 1, `${label}: exactly one new child transcript`, `${children.length}: ${children.join(", ")}`);
        if (parents.length !== 1 || children.length !== 1) return;

        const parentFile = parents[0];
        const child = readTranscript(children[0]);
        expect(
          child.header.parentSession === parentFile,
          `${label}: child parentSession points at the new parent`,
          `${path.basename(String(child.header.parentSession))} vs parent ${path.basename(parentFile)}`,
        );
        expect(
          child.assistantModels.length === 1 && child.assistantModels[0] === `${PROVIDER}/${expectedId}`,
          `${label}: child ran ${PROVIDER}/${expectedId}`,
          child.assistantModels.join(", ") || "(none)",
        );
        expect(child.userTurns === 1, `${label}: child has one user turn`, String(child.userTurns));

        const turns = turnRequests(capturesSince(captureStart));
        const childTurns = turns.filter((c) => c.model === expectedId);
        expect(childTurns.length === 1, `${label}: exactly one wire request on ${expectedId}`, describeCaptures(turns));
        if (expectedId === "slow-a") {
          expect(
            childTurns[0]?.reasoningEffort === "high",
            `${label}: slow-a slot requested reasoning_effort high`,
            `wire effort: ${String(childTurns[0]?.reasoningEffort)}`,
          );
        }
        // slow-b carries no pool suffix: on v19.2.1 a subagent turn to a
        // ladder-less model always carries the host's calibrated default
        // effort ("high"), so the wire effort here proves nothing about the
        // pool and is deliberately not asserted. The child identity assertion
        // above is the pool's claim under test.

        const doneResults = toolResultTexts(parentFile).filter((t) => TASK_RESULT_DONE.test(t) && TASK_OUTPUT_OK.test(t));
        expect(doneResults.length === 1, `${label}: successful task tool result`, `${doneResults.length} completed task-result envelope(s)`);
        const lastAssistant = assistantTurns(parentFile).slice(-1)[0];
        expect(
          lastAssistant?.content === "OK",
          `${label}: parent terminal OK`,
          `last assistant content: ${JSON.stringify(lastAssistant?.content ?? null)}`,
        );

        const expectedCursor = runNo % SLOW_POOL.length;
        expect(readCursor(isolated.stateFile, "slow") === expectedCursor, `${label}: slow cursor is ${expectedCursor}`, `state cursor: ${String(readCursor(isolated.stateFile, "slow"))}`);
      }

      // -- wraparound: ONE parent process, three sequential spawns -----------
      // reviewer → scout → reviewer shares one ROLE-keyed counter: 0 -> 1 ->
      // 0 -> 1, wrapping across agent names.
      {
        const label = "case 2 wraparound";
        const plan = [
          { name: "pool-review", agent: "reviewer" },
          { name: "pool-scout", agent: "scout" },
          { name: "pool-review-2", agent: "reviewer" },
        ];
        const { before, captureStart } = await runDelegationParent(isolated, plan, label);

        const fresh = newTranscripts(before, isolated);
        const parents = fresh.filter((f) => readTranscript(f).header?.parentSession === undefined);
        const children = fresh
          .map((file) => ({ file, transcript: readTranscript(file) }))
          .filter(({ transcript }) => transcript.header?.parentSession !== undefined);
        expect(parents.length === 1, `${label}: exactly one new parent transcript`, `${parents.length}: ${parents.join(", ")}`);
        expect(children.length === 3, `${label}: three distinct child transcripts`, `${children.length}: ${children.map((c) => path.basename(c.file)).join(", ")}`);
        if (parents.length !== 1 || children.length !== 3) return;

        const parentFile = parents[0];
        expect(
          children.every(({ transcript }) => transcript.header.parentSession === parentFile),
          `${label}: every child parentSession points at that parent`,
          children.map(({ transcript }) => path.basename(String(transcript.header.parentSession))).join(", ") || "(none)",
        );
        expect(
          children.every(({ transcript }) => transcript.userTurns === 1),
          `${label}: each child has one user turn`,
          children.map(({ transcript }) => String(transcript.userTurns)).join(", ") || "(none)",
        );

        // Children are identified by their transcript file name (the task
        // call's `name`), never by listing order: `findSessionFiles` sorts by
        // mtime, which is completion order, not spawn order.
        const expectedChildren = [
          { name: "pool-review", expects: "slow-a" },
          { name: "pool-scout", expects: "slow-b" },
          { name: "pool-review-2", expects: "slow-a" },
        ];
        const childrenByName = new Map(children.map(({ file, transcript }) => [path.basename(file, ".jsonl"), transcript]));
        for (const { name, expects } of expectedChildren) {
          const transcript = childrenByName.get(name);
          expect(transcript !== undefined, `${label}: child ${name} transcript exists`, `${[...childrenByName.keys()].join(", ") || "(none)"}`);
          if (transcript === undefined) return;
          expect(
            transcript.assistantModels.length > 0 && transcript.assistantModels.every((m) => m === `${PROVIDER}/${expects}`),
            `${label}: child ${name} ran ${PROVIDER}/${expects}`,
            transcript.assistantModels.join(", ") || "(none)",
          );
        }

        const turns = turnRequests(capturesSince(captureStart));
        const slowATurns = turns.filter((c) => c.model === "slow-a");
        const slowBTurns = turns.filter((c) => c.model === "slow-b");
        expect(slowATurns.length === 2 && slowBTurns.length === 1, `${label}: child wire requests are 2x slow-a, 1x slow-b`, describeCaptures(turns));
        expect(
          slowATurns.length === 2 && slowATurns.every((c) => c.reasoningEffort === "high"),
          `${label}: both slow-a slots requested reasoning_effort high`,
          slowATurns.map((c) => String(c.reasoningEffort)).join(", ") || "(none)",
        );
        // The scout slot (slow-b, no suffix) wires the host's calibrated
        // default effort for a ladder-less model (observed "high" on
        // v19.2.1), so its effort value is not pool evidence and is left
        // unasserted; the child identities above carry the wraparound proof.

        const doneResults = toolResultTexts(parentFile).filter((t) => TASK_RESULT_DONE.test(t) && TASK_OUTPUT_OK.test(t));
        expect(doneResults.length === 3, `${label}: three successful task tool results`, `${doneResults.length} completed task-result envelope(s)`);
        const lastAssistant = assistantTurns(parentFile).slice(-1)[0];
        expect(lastAssistant?.content === "OK", `${label}: parent terminal OK`, `last assistant content: ${JSON.stringify(lastAssistant?.content ?? null)}`);

        expect(
          readCursor(isolated.stateFile, "slow") === 1,
          `${label}: slow cursor after wraparound is 1 (next pick is slot 1)`,
          `state cursor: ${String(readCursor(isolated.stateFile, "slow"))}`,
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Case 2b — fail-open with a real host; strict blocks only behind config.
// ---------------------------------------------------------------------------

async function caseFailOpenAndStrict() {
  // Gap B: a pool whose only entry resolves to nothing must fail OPEN on a
  // real host: the child still spawns on the role's pinned model, the pool
  // cursor never advances, and the fixture never sees the dead selector.
  const brokenPool = [`${PROVIDER}/does-not-exist`];
  const failOpenConfig = { slow: brokenPool, enableMainSessionRotation: false, persistCounters: true };
  await inIsolatedRoot(
    "case-2b fail-open",
    caseOptions(failOpenConfig, { overlayExtra: ["modelRoles:", `  slow: ${PIN_SELECTOR}`] }),
    async (isolated) => {
      writeModelsYaml(isolated.agentDir, fixture.port);
      const { before, captureStart, rejectionStart } = await runDelegationParent(isolated, [{ name: "pool-review", agent: "reviewer" }], "case 2b fail-open");

      const fresh = newTranscripts(before, isolated);
      const children = fresh.filter((f) => readTranscript(f).header?.parentSession !== undefined);
      expect(children.length === 1, "case 2b fail-open: the child still spawned", `${children.length} child transcript(s)`);
      if (children.length !== 1) return;
      const child = readTranscript(children[0]);
      expect(
        child.assistantModels.length === 1 && child.assistantModels[0] === PIN_SELECTOR,
        "case 2b fail-open: child ran on the pinned role model",
        child.assistantModels.join(", ") || "(none)",
      );
      const parentFile = fresh.find((f) => readTranscript(f).header?.parentSession === undefined);
      if (parentFile === undefined) throw new StepFailure("case 2b fail-open: parent transcript present", "no new parent transcript");
      const doneResults = toolResultTexts(parentFile).filter((t) => TASK_RESULT_DONE.test(t) && TASK_OUTPUT_OK.test(t));
      expect(doneResults.length === 1, "case 2b fail-open: successful task tool result", `${doneResults.length} completed task-result envelope(s)`);

      expect(
        !selectorAttempted(capturesSince(captureStart), fixture.rejections.slice(rejectionStart)),
        "case 2b fail-open: fixture never received the dead selector",
        describeCaptures(capturesSince(captureStart)),
      );
      const counters = readStateCounters(isolated.stateFile);
      expect(
        counters === undefined || counters.slow === undefined,
        "case 2b fail-open: no slow cursor advance persisted",
        JSON.stringify(counters ?? null),
      );
    },
  );

  // Gap C: the same broken pool with `strict: ["slow"]` must BLOCK the spawn
  // with the configured reason, not silently pin. `strict` is a real
  // extension config key (boolean | string[]), so nothing is invented here.
  const strictConfig = { slow: brokenPool, enableMainSessionRotation: false, persistCounters: true, strict: ["slow"] };
  await inIsolatedRoot(
    "case-2c strict",
    caseOptions(strictConfig, { overlayExtra: ["modelRoles:", `  slow: ${PIN_SELECTOR}`] }),
    async (isolated) => {
      writeModelsYaml(isolated.agentDir, fixture.port);
      const { before, captureStart, rejectionStart } = await runDelegationParent(isolated, [{ name: "pool-review", agent: "reviewer" }], "case 2c strict");

      expect(
        !selectorAttempted(capturesSince(captureStart), fixture.rejections.slice(rejectionStart)),
        "case 2c strict: the spawn was refused before any model call",
        describeCaptures(capturesSince(captureStart)),
      );

      const fresh = newTranscripts(before, isolated);
      const children = fresh.filter((f) => readTranscript(f).header?.parentSession !== undefined);
      expect(children.length === 0, "case 2c strict: spawn blocked, no child transcript", `${children.length} child transcript(s): ${children.join(", ")}`);

      const parents = fresh.filter((f) => readTranscript(f).header?.parentSession === undefined);
      if (parents.length !== 1) {
        throw new StepFailure("case 2c strict: parent transcript present", `${parents.length} parent transcript(s)`);
      }
      const completed = toolResultTexts(parents[0]).filter((t) => t.includes("status=\"completed\""));
      expect(completed.length === 0, "case 2c strict: no successful task result", `${completed.length} completed task-result envelope(s)`);
      const blocked = toolResultTexts(parents[0]).filter((t) => t.includes(STRICT_BLOCK_REASON));
      expect(blocked.length > 0, "case 2c strict: block reason surfaced to the parent", `${blocked.length} tool result(s) carried the reason`);

      const counters = readStateCounters(isolated.stateFile);
      expect(
        counters === undefined || counters.slow === undefined,
        "case 2c strict: no slow cursor advance persisted",
        JSON.stringify(counters ?? null),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Case 3 — mistral-live discovery through `omp models refresh mistral`.
// ---------------------------------------------------------------------------

const MISTRAL_EXT = path.join(MISTRAL_PACKAGE, "src", "mistral-live.ts");
const MISTRAL_A = "mistral-e2e-chat-a";
const MISTRAL_B = "mistral-e2e-chat-b";

/**
 * The listing a `models refresh mistral --json` run prints, restricted to the
 * `mistral` provider. Strictly parsed from the command output — the suite
 * never inspects host cache files.
 */
function mistralListing(stdout) {
  if (typeof stdout !== "string") return undefined;
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.models)) return undefined;
  return doc.models.filter((m) => m !== null && typeof m === "object" && m.provider === "mistral");
}

async function caseMistralRefresh() {
  const chatRequestsBefore = fixture.stats().chatRequests;
  const providerEnv = {
    // Mirrors MISTRAL_FIXTURE_API_KEY in loopback.mjs by construction: one
    // constant feeds the env and the roster route's bearer check.
    MISTRAL_API_KEY: MISTRAL_FIXTURE_API_KEY,
    OMP_MISTRAL_LIVE_BASE_URL: `${fixtureUrl()}/v1`,
  };
  await inIsolatedRoot("case-3 mistral refresh", caseOptions({}, { providerEnv }), async (isolated) => {
    if (!existsSync(MISTRAL_EXT)) {
      throw new StepFailure("case-3 mistral refresh: mistral-live extension present", `missing ${MISTRAL_EXT}`);
    }
    record("case 3: mistral-live extension present", "pass", path.relative(repoRoot, MISTRAL_EXT));

    const args = ["models", "refresh", "mistral", "--json", "--no-extensions", "-e", MISTRAL_EXT, "--config", isolated.overlayFile];

    // Refresh 1 — roster A. On success the discovery is authoritative: exactly
    // A survives, with the fixture's context window. No embed row, and no
    // bundled mistral-large-4 chat seed alongside it.
    fixture.enqueueMistralRoster({
      data: [
        { id: MISTRAL_A, max_context_length: 64000, capabilities: { completion_chat: true } },
        { id: "mistral-e2e-embed", capabilities: { completion_chat: false } },
      ],
    });
    const res1 = await spawnOmp(isolated, args, "case 3 refresh 1");
    const stats1 = fixture.stats();
    const listing1 = mistralListing(res1.stdout);
    const ids1 = (listing1 ?? []).map((m) => m.id);
    expect(stats1.modelsRequests === 1 && stats1.unauthenticatedModelsRequests === 0, "case 3 refresh 1: one authenticated fetch", `${stats1.modelsRequests} authenticated, ${stats1.unauthenticatedModelsRequests} unauthenticated`);
    expect(
      ids1.length === 1 && ids1[0] === MISTRAL_A,
      "case 3 refresh 1: catalog has exactly mistral-e2e-chat-a",
      `ids: ${ids1.join(", ") || "(none)"}`,
    );
    const rowA = (listing1 ?? []).find((m) => m.id === MISTRAL_A);
    expect(rowA?.contextWindow === 64000, "case 3 refresh 1: A contextWindow 64000", `context: ${String(rowA?.contextWindow)}`);
    expect(!ids1.includes("mistral-e2e-embed"), "case 3 refresh 1: non-chat embed row dropped", ids1.join(", "));
    expect(
      !ids1.some((id) => typeof id === "string" && id.startsWith("mistral-large-4")),
      "case 3 refresh 1: no bundled mistral-large-4 chat seed",
      ids1.join(", "),
    );

    // Refresh 2 — roster B replaces A.
    fixture.enqueueMistralRoster({ data: [{ id: MISTRAL_B, max_context_length: 64000, capabilities: { completion_chat: true } }] });
    const res2 = await spawnOmp(isolated, args, "case 3 refresh 2");
    const ids2 = (mistralListing(res2.stdout) ?? []).map((m) => m.id);
    expect(ids2.includes(MISTRAL_B), "case 3 refresh 2: B present", ids2.join(", ") || "(none)");
    expect(!ids2.includes(MISTRAL_A), "case 3 refresh 2: A replaced", ids2.join(", "));
    expect(fixture.stats().modelsRequests === 2, "case 3 refresh 2: one more authenticated fetch", `${fixture.stats().modelsRequests} authenticated GET(s)`);

    // Refresh 3 — malformed payload (`data: [null]`): one more authenticated
    // fetch, a discovery failure warning, and B still served from the cached
    // catalog. The host may resurface bundled rows on a stale refresh; that
    // is deliberately not asserted.
    fixture.enqueueMistralRoster({ data: [null] });
    const res3 = await spawnOmp(isolated, args, "case 3 refresh 3");
    expect(
      fixture.stats().modelsRequests === 3,
      "case 3 refresh 3: another authenticated fetch",
      `${fixture.stats().modelsRequests} authenticated GET(s)`,
    );
    const warnLine = res3.stderr.split(/\r?\n/).find((l) => /discovery failed/i.test(l) && /mistral/i.test(l));
    expect(
      warnLine !== undefined && /mistral-live/i.test(res3.stderr),
      "case 3 refresh 3: Mistral discovery failure warning",
      warnLine?.trim().slice(0, 200) ?? "(no discovery failure warning on stderr)",
    );
    const ids3 = (mistralListing(res3.stdout) ?? []).map((m) => m.id);
    expect(ids3.includes(MISTRAL_B), "case 3 refresh 3: B still present from cache", ids3.join(", ") || "(none)");
    expect(fixture.stats().unauthenticatedModelsRequests === 0, "case 3: fixture bearer accepted on every fetch", `${fixture.stats().unauthenticatedModelsRequests} unauthenticated roster fetches`);

    // Discovery submits no inference: every chat request the fixture served
    // belongs to the earlier cases.
    expect(
      fixture.stats().chatRequests === chatRequestsBefore,
      "case 3: no chat request hit the fixture",
      `${fixture.stats().chatRequests - chatRequestsBefore} chat requests during case 3`,
    );
  });
}

// ---------------------------------------------------------------------------
// Binary availability: the one legitimate skip, and only off-CI.
// ---------------------------------------------------------------------------

/**
 * `omp --version` through the same allowlist discipline as every other
 * spawn: no owner environment, no owner state. A missing binary is only a
 * skip off-CI with no pinned OMP_BIN; anywhere it is pinned it must exist.
 */
async function probeOmpBinary() {
  const probeEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) probeEnv[key] = process.env[key];
  }
  const res = await runOmp(["--version"], { cwd: process.cwd(), env: probeEnv, timeoutMs: PROCESS_TIMEOUT_MS });
  const missing = res.code === null && !res.timedOut && /ENOENT/i.test(res.stderr);
  return { res, missing };
}

// ---------------------------------------------------------------------------
// Suite lifecycle.
// ---------------------------------------------------------------------------

let fixture;

function fixtureUrl() {
  return fixture === undefined ? "http://127.0.0.1:9" : fixture.url;
}

async function main() {
  console.log(`e2e: deterministic real-OMP loopback suite (repo ${path.basename(repoRoot)})`);
  const beforeHashes = hashOwnerConfig();
  const swept = sweepAbandonedRoots();
  if (swept.length > 0) console.log(`swept ${swept.length} abandoned run root(s) from earlier interrupted runs`);

  const { res: probe, missing } = await probeOmpBinary();
  if (missing) {
    const pinned = process.env.OMP_BIN !== undefined && process.env.OMP_BIN.length > 0;
    if (pinned || process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
      record("omp binary available", "fail", `OMP_BIN=${process.env.OMP_BIN ?? "(unset)"} could not be executed; in CI the pinned binary must exist`);
    } else {
      record("omp binary available", "skip", "no OMP binary via OMP_BIN/PATH/bun install; install oh-my-pi to run the E2E locally");
    }
    printSummary();
    return;
  }
  record("omp binary available", "pass", path.basename(probe.bin));

  fixture = await startLoopbackFixture();
  record("loopback fixture listening", "pass", `127.0.0.1:${fixture.port}`);

  try {
    await caseRotation();
    await caseInMemoryRotation();
    await caseDelegation();
    await caseFailoverChain();
    await caseBoundedChain();
    await caseFailOpenAndStrict();
    await caseMistralRefresh();

    const stats = fixture.stats();
    expect(stats.unauthenticatedModelsRequests === 0, "fixture: no unauthenticated roster fetch", `${stats.unauthenticatedModelsRequests}`);
    expect(!stats.overrun, "fixture: request cap never exceeded", `${stats.chatRequests} chat requests served`);
  } catch (err) {
    if (err instanceof StepFailure) {
      record(err.step, "fail", err.detail);
    } else {
      record("e2e suite crashed", "fail", detailOf(err));
    }
  } finally {
    const closed = fixture === undefined ? undefined : await fixture.close();
    record("loopback server closed", closed === true ? "pass" : "fail", closed === true ? "" : "server was still listening after close()");
    // Cases clean their own roots in `finally`; this catches a case that
    // failed its own cleanup or never reached it.
    for (const isolated of [...liveRoots]) {
      const removed = await isolated.cleanup();
      if (removed) liveRoots.delete(isolated);
      record(`${isolated.label}: temp root removed (retry)`, removed ? "pass" : "fail", isolated.root);
    }
    const afterHashes = hashOwnerConfig();
    const changed = diffManifests(beforeHashes, afterHashes);
    record("owner configuration untouched", changed.length === 0 ? "pass" : "fail", changed.length === 0 ? "all hashes unchanged" : `changed: ${changed.join(", ")}`);
  }
  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.status === "pass").length;
  console.log(`\ne2e: ${passed}/${results.length} checks passed, ${failures} failed, ${skips} skipped`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`e2e suite crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
