// Optional internet smoke suite: prove the pool extension rotates real OMP
// runs across *verified free* routes and that Mistral live discovery works —
// strictly free, strictly optional, and never spending a paid token.
//
// Not part of `npm test` (that globs *.test.mjs). Run via `npm run test:live`.
//
// What this proves and how:
//   * route discipline: a route is serviced only when the provider's live
//     catalog proves it free (free-routes.mjs); anything unverifiable is a
//     skip, proven-unfree or malformed explicit input is a failure.
//   * isolation: the sandbox OMP child gets a fresh home, a dummy per-run
//     bearer, and a generated `models.yml` that routes the `smoke-…` providers
//     to a loopback relay. Real provider credentials stay in this process and
//     are forwarded only by the relay, only for admitted, allowlisted
//     requests. Before any proxied inference, `omp models --json` must already
//     list all three isolated selectors, so OMP cannot silently fall back to a
//     paid or unverified route.
//   * rotation: two fresh main runs over the shared [B, A] cursor change
//     models (evidence = the model OMP recorded on the assistant turn, plus a
//     matching wire request through the relay), and an exact resume of the
//     second run does not re-rotate. Persisted cursors are asserted exactly.
//
// Anything unproven is reported as skipped with the reason, never as a pass.
// Secrets, headers, env values, and raw request errors are never printed.
// Credentials resolve inside this process only — KILO_API_KEY,
// OPENROUTER_API_KEY, and MISTRAL_API_KEY from the invoking environment — and
// never reach the sandbox child.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

import {
  createIsolatedEnv,
  diffManifests,
  hashOwnerConfig,
  sweepAbandonedRoots,
  writeRunManifest,
} from "./isolated-env.mjs";
import { findSessionFiles, parseJsonOutput, readTranscript, runOmp } from "./omp-runner.mjs";
import {
  acceptedEvidence,
  cursorExpectation,
  resolveProviderCredential,
  selectRoutes,
} from "./free-routes.mjs";
import {
  createFreeGateway,
  toSmokeSelector,
  publicSelectorFromSmokeIdentity,
  renderSmokeProvidersYaml,
} from "./free-gateway.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
/** The pool extension package; the live harness itself stays at the root. */
const POOL_PACKAGE = path.join(repoRoot, "packages", "model-pool");
const PROMPT = "Reply with exactly: OK";
const OMP_RUN_TIMEOUT_MS = 240_000;
/** Credential env overrides that may exist in the invoking environment, never in the sandbox. */
const SECRET_ENV_KEYS = ["KILO_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY"];

const results = [];
let failures = 0;

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const mark = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (status === "fail") failures += 1;
}

/** Last stderr line, any bearer scrubbed, and truncated: enough to diagnose, never a token. */
function stderrTail(res) {
  const raw = res.stderr.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  const line = (raw[raw.length - 1] ?? "").replace(/bearer\s+\S+/gi, "bearer [redacted]");
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** `{ "KILO_API_KEY": true, ... }` — presence in the invoking environment only. */
function secretKeyPresence() {
  const out = {};
  for (const key of SECRET_ENV_KEYS) {
    out[key] = typeof process.env[key] === "string" && process.env[key].trim().length > 0;
  }
  return out;
}

/** The persisted round-robin cursor for the main role, or undefined when unreadable. */
function readPersistedCursor(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    const value = parsed !== null && typeof parsed === "object" ? parsed.counters?.default : undefined;
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** New candidates for skippable-provider outcomes: statuses within the spec'd skip classes. */
function firstSkippableUpstreamProblem(statuses) {
  for (const status of statuses) {
    if (status === "timeout") return "the free route did not answer within the relay's 30-second deadline";
    if (typeof status === "number") {
      if (status >= 500) return `the free route answered HTTP ${status} (server-side)`;
      if (status === 401 || status === 403) return `the free route rejected the smoke credentials (HTTP ${status})`;
      if (status === 404) return "the free route is no longer served (HTTP 404)";
      if (status === 429) return `the free route rate limited the turn (HTTP ${status})`;
    }
  }
  return "";
}

function summarize() {
  const skips = results.filter((r) => r.status === "skip").length;
  const passes = results.filter((r) => r.status === "pass").length;
  console.log(`\nsummary: ${passes} passed, ${skips} skipped, ${failures} failed`);
}

/**
 * Independent, route-independent Mistral live check.
 *
 * Calls the built `fetchMistralLiveModels` from dist/mistral-live.js against
 * the default official URL with a redirect-rejecting fetch wrapper — the only
 * network traffic is `GET https://api.mistral.ai/v1/models`. No chat call, no
 * price gate, and no ambient URL/disable override is applied.
 *
 * Expected network/auth/rate/transient errors are skips with a categorized
 * reason; a malformed success payload or an empty chat roster is a failure.
 */
async function checkMistralLive() {
  // The invoking environment's MISTRAL_API_KEY is the only source; the key
  // never leaves this process except in the outbound bearer header.
  const key = (await resolveProviderCredential("mistral")) ?? "";
  if (key.length === 0) {
    record("mistral live discovery", "skip", "no credential for mistral");
    return;
  }
  const distFile = path.join(repoRoot, "packages", "mistral-live", "dist", "mistral-live.js");
  let fetchMistralLiveModels;
  try {
    ({ fetchMistralLiveModels } = await import(pathToFileURL(distFile).href));
  } catch {
    record("mistral live discovery", "fail", "dist/mistral-live.js is missing; run npm run build first");
    return;
  }
  if (typeof fetchMistralLiveModels !== "function") {
    record("mistral live discovery", "fail", "dist/mistral-live.js does not export fetchMistralLiveModels");
    return;
  }

  // Redirect-rejecting wrapper: a "successful" redirect would be exactly the
  // credential-leak shape this suite exists to exclude.
  const redirectRejectingFetch = (input, init = {}) =>
    globalThis.fetch(input, { ...init, redirect: "error" });

  try {
    const models = await fetchMistralLiveModels(key, { fetch: redirectRejectingFetch });
    if (!Array.isArray(models) || models.length === 0) {
      record("mistral live discovery", "fail", "the live payload parsed to an empty chat roster");
      return;
    }
    const bad = models.filter(
      (m) => !(Number.isFinite(m?.contextWindow) && m.contextWindow > 0) || !(Number.isFinite(m?.maxTokens) && m.maxTokens > 0),
    );
    if (bad.length > 0) {
      record("mistral live discovery", "fail", `${bad.length} of ${models.length} rows carry non-positive limits`);
      return;
    }
    record("mistral live discovery", "pass", `${models.length} chat models with positive limits`);
  } catch (err) {
    const category = categorizeMistralError(err);
    if (category === undefined) {
      record("mistral live discovery", "fail", "the live request failed in an uncharacterizable way");
      return;
    }
    record("mistral live discovery", "skip", category);
  }
}

/** Categories for expected Mistral failures; undefined means "not expected", which fails. */
function categorizeMistralError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status === "401" || status === "403") return `mistral rejected the credentials (HTTP ${status})`;
  if (status === "429") return "mistral rate limited the request (HTTP 429)";
  if (status !== undefined) return `mistral answered HTTP ${status} (transient or server-side)`;
  const code =
    err instanceof Error && err.cause !== null && typeof err.cause === "object" && typeof err.cause.code === "string"
      ? err.cause.code
      : err instanceof Error && typeof err.code === "string"
        ? err.code
        : "";
  if (err instanceof Error && err.name === "AbortError") return "the /models request timed out";
  if (code === "UND_ERR_ABORTED" || /(timed out|timeout)/i.test(code)) return "the /models request timed out";
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR)/.test(code)) {
    return `network error reaching mistral (${code})`;
  }
  if (/fetch failed|network/i.test(message)) return "network error reaching mistral";
  return undefined;
}

/** New transcripts since `started`, and the one carrying a fresh assistant turn. */
function collectSandboxTranscripts(isolated, started) {
  const now = findSessionFiles(isolated.sessionDir).map((s) => s.file);
  const fresh = now.filter((file) => !started.has(file));
  const withAssistants = fresh.map((file) => readTranscript(file)).filter((t) => t.assistantModels.length > 0);
  return { fresh, withAssistants };
}

/**
 * Drive the verified trio end to end inside the already-prepared sandbox.
 *
 * The two fresh runs share the persisted [B, A] cursor and the relay's
 * per-route request log; the resume phase only runs when the second fresh run
 * genuinely succeeded. Skips require the relay to have observed a matching
 * admitted request; missing transcripts, unexpected models, unadmitted routes,
 * and wrong persisted cursors are failures.
 */
async function runSmokeTrio({ isolated, gateway, smokePin, smokePool }) {
  let run2TranscriptFile;
  let cursor = 0;

  for (let i = 0; i < smokePool.length; i += 1) {
    const expected = smokePool[i];
    const name = `main run ${i + 1} rotates to ${publicSelectorFromSmokeIdentity(expected)}`;
    const filesBefore = new Set(findSessionFiles(isolated.sessionDir).map((s) => s.file));
    const countsBefore = gateway.snapshot();
    const res = await runOmp(
      [...isolated.ompArgs, "--model", smokePin, "-p", PROMPT],
      { cwd: isolated.workDir, env: isolated.env, timeoutMs: OMP_RUN_TIMEOUT_MS },
    );
    const countsAfter = gateway.snapshot();
    // The relay keys its counters by the PUBLIC selector that was verified
    // against the provider catalog; the sandbox runs the translated
    // `smoke-<provider>` selector. Comparing either side to the other
    // namespace silently yields zero admissions, which used to be reported as
    // "unadmitted route" and also froze the expected cursor.
    const publicExpected = publicSelectorFromSmokeIdentity(expected);
    const slot = countsAfter.bySelector[publicExpected];
    const admitted = (slot?.admitted ?? 0) - (countsBefore.bySelector[publicExpected]?.admitted ?? 0);
    const newStatuses = (slot?.statuses ?? []).slice(
      countsBefore.bySelector[publicExpected]?.statuses.length ?? 0,
    );
    const { fresh, withAssistants } = collectSandboxTranscripts(isolated, filesBefore);

    // Provider skips need both halves: the selector's own wire request went
    // out (matching admitted request) and the failure is one of the spec'd
    // provider classes (timeout, 401/403/404/429, 5xx).
    const providerProblem = firstSkippableUpstreamProblem(newStatuses);
    if (providerProblem !== "" && admitted >= 1) {
      record(name, "skip", `${providerProblem}; the relay observed ${admitted} admitted request(s)`);
    } else if (res.timedOut) {
      record(
        name,
        admitted >= 1 ? "skip" : "fail",
        admitted >= 1
          ? "the free route did not finish within the run budget (admitted request observed; the cursor below still proves the pick)"
          : `omp ran past the ${OMP_RUN_TIMEOUT_MS}ms budget without reaching the relay`,
      );
    } else if (res.code !== 0) {
      record(name, "fail", `omp exited ${res.code}: ${stderrTail(res) || "no stderr"}`);
    } else if (withAssistants.length !== 1) {
      record(
        name,
        "fail",
        fresh.length === 0
          ? "omp exited 0 without writing a transcript"
          : withAssistants.length === 0
            ? "the run's only transcript records no assistant turn"
            : `${withAssistants.length} new transcripts carry assistant turns; expected exactly one`,
      );
    } else if (!withAssistants[0].assistantModels.every((m) => m === expected)) {
      record(
        name,
        "fail",
        `expected ${publicSelectorFromSmokeIdentity(expected)}, omp ran ${withAssistants[0].assistantModels.join(", ") || "(nothing)"}`,
      );
    } else if (admitted === 0) {
      record(name, "fail", "unadmitted route: no wire request for the expected model");
    } else {
      const upstream = newStatuses.map((s) => (typeof s === "number" ? `HTTP ${s}` : String(s))).join(", ");
      if (i === 1) run2TranscriptFile = withAssistants[0].file;
      record(
        name,
        "pass",
        `ran on ${publicSelectorFromSmokeIdentity(expected)} with ${admitted} admitted request(s); upstream: ${upstream}`,
      );
    }
    // The cursor follows the *accepted* pick, not the wire request: OMP commits
    // the slot as soon as it applies the model and records that as a
    // `model_change` entry, which precedes any provider call. Inspecting every
    // fresh transcript (not only those with an assistant turn) is what keeps a
    // run that crashed after the change from being judged as "nothing
    // accepted". No transcript at all is unknown evidence, not a failure.
    const parsedFresh = fresh.map((file) => readTranscript(file));
    const accepted = acceptedEvidence(parsedFresh, expected);
    const expectation = cursorExpectation({
      accepted,
      hadEvidence: parsedFresh.length > 0,
      previous: cursor,
      poolLength: smokePool.length,
    });
    const actualCursor = readPersistedCursor(isolated.stateFile);
    if (expectation.status === "skip") {
      record(`persisted cursor after run ${i + 1}`, "skip", expectation.reason);
    } else {
      cursor = expectation.expected;
      record(
        `persisted cursor after run ${i + 1}`,
        actualCursor === cursor ? "pass" : "fail",
        `expected ${cursor} (${expectation.reason}), got ${actualCursor === undefined ? "unreadable" : actualCursor}`,
      );
    }
  }

  // --- exact resume of run 2 must not re-rotate -------------------------------
  if (run2TranscriptFile === undefined) {
    record("exact resume does not re-rotate", "skip", "no passing second transcript to resume");
  } else {
    await runResumePhase({ isolated, gateway, smokePool, cursorValue: cursor, transcriptFile: run2TranscriptFile });
  }
}

async function runResumePhase({ isolated, gateway, smokePool, cursorValue, transcriptFile }) {
  const expected = smokePool[1];
  // Snapshot before the resume runs: a no-op resume that exits 0 must not
  // inherit the qualifying turns already in the file.
  const before = existsSync(transcriptFile) ? readTranscript(transcriptFile) : undefined;
  const countsBefore = gateway.snapshot();
  const res = await runOmp(
    [...isolated.ompArgs, "--resume", transcriptFile, "-p", PROMPT],
    { cwd: isolated.workDir, env: isolated.env, timeoutMs: OMP_RUN_TIMEOUT_MS },
  );
  const countsAfter = gateway.snapshot();
  const publicExpected = publicSelectorFromSmokeIdentity(expected);
  const slot = countsAfter.bySelector[publicExpected];
  const admitted = (slot?.admitted ?? 0) - (countsBefore.bySelector[publicExpected]?.admitted ?? 0);
  const newStatuses = (slot?.statuses ?? []).slice(
    countsBefore.bySelector[publicExpected]?.statuses.length ?? 0,
  );
  const transcript = existsSync(transcriptFile) ? readTranscript(transcriptFile) : undefined;
  const addedUser = before === undefined || transcript === undefined ? 0 : transcript.userTurns - before.userTurns;
  const addedAssistant =
    before === undefined || transcript === undefined
      ? 0
      : transcript.assistantModels.length - before.assistantModels.length;
  const complete = res.code === 0 && addedUser === 1 && addedAssistant === 1;
  const last = complete ? transcript.assistantModels[transcript.assistantModels.length - 1] : undefined;
  const providerProblem = firstSkippableUpstreamProblem(newStatuses);
  if (last === expected && admitted >= 1) {
    record(
      "exact resume does not re-rotate",
      "pass",
      `resumed turn added one assistant turn on the restored ${publicSelectorFromSmokeIdentity(expected)} ` +
        `(${addedUser} user / ${addedAssistant} assistant turn(s) added)`,
    );
  } else if (last === expected) {
    record(
      "exact resume does not re-rotate",
      "fail",
      "the resumed transcript changed but no wire request reached the expected model",
    );
  } else if (complete) {
    record(
      "exact resume does not re-rotate",
      "fail",
      `resume ran on ${last ?? "(nothing)"}; a rotation would have applied ${publicSelectorFromSmokeIdentity(smokePool[0])}`,
    );
  } else if (providerProblem !== "" && admitted >= 1) {
    record("exact resume does not re-rotate", "skip", `${providerProblem}; wire request observed`);
  } else if (res.timedOut) {
    record(
      "exact resume does not re-rotate",
      admitted >= 1 ? "skip" : "fail",
      admitted >= 1
        ? "the free route did not finish within the run budget (admitted request observed)"
        : `omp ran past the ${OMP_RUN_TIMEOUT_MS}ms budget without reaching the relay`,
    );
  } else if (res.code !== 0) {
    record("exact resume does not re-rotate", "fail", `omp exited ${res.code}: ${stderrTail(res) || "no stderr"}`);
  } else {
    record(
      "exact resume does not re-rotate",
      "fail",
      `the resume added ${addedUser} user / ${addedAssistant} assistant turn(s), expected exactly one of each ` +
        `(exit ${res.code ?? "null"})`,
    );
  }
  const actualCursor = readPersistedCursor(isolated.stateFile);
  record(
    "persisted cursor after resume",
    actualCursor === cursorValue ? "pass" : "fail",
    `expected ${cursorValue} (a resume consumes no slot), got ${actualCursor === undefined ? "unreadable" : actualCursor}`,
  );
}

async function main() {
  const swept = sweepAbandonedRoots();
  if (swept.length > 0) {
    console.log(`swept ${swept.length} abandoned run root(s) from earlier interrupted runs`);
  }
  const beforeHashes = hashOwnerConfig();
  const keyPresence = secretKeyPresence();

  let isolated;
  let gateway;
  let verifiedTrio = [];
  try {
    // Isolation first, manifest before any probing: an interrupted or skipped
    // run still leaves a secret-free audit trail inside its own temp root.
    // The pool wiring is finalised after route selection by mutating `env`
    // (the supported way to add per-case variables) before any spawn.
    isolated = createIsolatedEnv(
      {
        poolConfig: { pools: {}, persistCounters: true, enableMainSessionRotation: true, mainSessionRole: "default" },
        repoRoot: POOL_PACKAGE,
        label: "free-smoke",
      },
    );
    const manifestPath = writeRunManifest(isolated, {
      phase: "start",
      label: isolated.label,
      startedAt: new Date().toISOString(),
      host: { platform: process.platform, node: process.version },
      credentialEnvOverrides: keyPresence,
      ompLiveRoutes: (process.env.OMP_LIVE_ROUTES ?? "").trim() || null,
    });
    if (manifestPath === undefined) {
      record("run manifest", "fail", "the run root vanished before the initial manifest could be written");
    } else {
      record("run manifest", "pass", "initial secret-free manifest written before probing");
    }

    // Independent of routes: Mistral discovery always runs when its key is set.
    await checkMistralLive();

    // Nothing below may see a real key: prove the sandbox env is clean.
    const leaked = SECRET_ENV_KEYS.filter((key) => isolated.env[key] !== undefined);
    record(
      "provider credentials kept out of the sandbox",
      leaked.length === 0 ? "pass" : "fail",
      leaked.length === 0 ? "no credential env var in the sandbox child" : `leaked: ${leaked.join(", ")}`,
    );

    const selection = await selectRoutes();
    if (selection.status !== "ok") {
      record("free route discovery", selection.status, selection.reason);
      return;
    }
    const trio = selection.routes;
    verifiedTrio = trio;
    const [pin, poolB, poolA] = [trio[0].selector, trio[1].selector, trio[2].selector];
    const providerSummary = [...new Set(trio.map((route) => route.provider))].join(" + ");
    record(
      "free route discovery",
      "pass",
      `pinned start ${pin}, pool rotates [${poolB}, ${poolA}] (providers: ${providerSummary})${selection.reason ? ` — ${selection.reason}` : ""}`,
    );

    // Relay up before anything else is generated: models.yml needs the port.
    // The keys were already proven resolvable by the route verification;
    // resolving again re-reads the same invoking-environment variable.
    const providerKeys = {};
    for (const provider of ["kilo", "openrouter"]) {
      if (verifiedTrio.some((route) => route.provider === provider)) {
        providerKeys[provider] = (await resolveProviderCredential(provider)) ?? "";
      }
    }
    gateway = await createFreeGateway({ routes: trio, providerKeys, log: (line) => console.log(line) });
    writeFileSync(
      path.join(isolated.agentDir, "models.yml"),
      renderSmokeProvidersYaml({ routes: trio, bearer: gateway.bearer, port: gateway.port }),
      "utf8",
    );

    // Final pool wiring, set before the first spawn (the listing run below
    // runs with --no-extensions and cannot touch it).
    const smokePin = toSmokeSelector(pin);
    const smokePool = [toSmokeSelector(poolB), toSmokeSelector(poolA)];
    const isolatedTrio = [smokePin, ...smokePool];
    if (isolatedTrio.some((s) => s === null)) {
      record("isolated selector translation", "fail", "a verified route did not translate to a smoke- provider");
      return;
    }
    isolated.env.OMP_MODEL_POOLS_JSON = JSON.stringify({
      pools: { default: smokePool },
      persistCounters: true,
      enableMainSessionRotation: true,
      mainSessionRole: "default",
    });

    // Gate: the isolated registry must already list all three selectors before
    // either prompt runs, so no run can silently fall back to a paid route.
    const listed = await runOmp(
      ["models", "--json", "--no-extensions", "--config", isolated.overlayFile],
      { cwd: isolated.workDir, env: isolated.env, timeoutMs: 60_000 },
    );
    const selectors = Array.isArray(parseJsonOutput(listed.stdout)?.models)
      ? parseJsonOutput(listed.stdout).models.map((m) => (typeof m?.selector === "string" ? m.selector : "")).filter((s) => s.length > 0)
      : [];
    const missing = isolatedTrio.filter((selector) => !selectors.includes(selector));
    if (listed.code !== 0 || missing.length > 0) {
      record(
        "isolated model registry lists all smoke selectors",
        "fail",
        listed.code !== 0
          ? `omp models exited ${listed.code}: ${stderrTail(listed) || "no stderr"}`
          : `missing: ${missing.join(", ")}`,
      );
      return;
    }
    record("isolated model registry lists all smoke selectors", "pass", isolatedTrio.join(", "));

    await runSmokeTrio({ isolated, gateway, smokePin, smokePool });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record("live smoke", "fail", `crashed without a staged result: ${message.slice(0, 200)}`);
  } finally {
    if (gateway !== undefined) {
      try {
        await gateway.close();
      } catch (err) {
        console.error(`the relay did not close cleanly: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (isolated !== undefined) {
      const changed = diffManifests(beforeHashes, hashOwnerConfig());
      record(
        "owner configuration untouched",
        changed.length === 0 ? "pass" : "fail",
        changed.length === 0 ? "all hashes unchanged" : `changed: ${changed.join(", ")}`,
      );
      const removed = await isolated.cleanup();
      if (removed) {
        record("run root removed", "pass", "temp root deleted; no completed manifest is left behind on purpose");
      } else {
        record("run root removed", "skip", `${isolated.root} survived; the sweep collects it later`);
        // Only when the root survives is there a place to record the outcome.
        try {
          const finished = writeRunManifest(isolated, {
            phase: "complete",
            label: isolated.label,
            finishedAt: new Date().toISOString(),
            credentialEnvOverrides: keyPresence,
            routes: {
              public: verifiedTrio.map((route) => route.selector),
              providers: [...new Set(verifiedTrio.map((route) => route.provider))],
            },
            relay: gateway === undefined ? undefined : gateway.snapshot(),
            results,
          });
          if (finished === undefined) {
            console.error(`could not write the completed run manifest into ${isolated.root}`);
          }
        } catch (err) {
          console.error(`could not write the completed run manifest: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // Exit status is committed here, inside the finally: an early `return`
    // inside the body (a failed route selection, an unlisted selector) still
    // runs this block, so the summary is printed and a recorded FAIL cannot
    // exit 0. Every handle is closed above, so a plain exitCode suffices — no
    // forced exit that could truncate output or kill a still-draining child.
    summarize();
    process.exitCode = failures === 0 ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(`live suite crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
