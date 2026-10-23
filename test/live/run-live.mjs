// Optional live suite: prove the extension works against a real installed OMP.
//
// Not part of `npm test` (that globs *.test.mjs). Run with `npm run test:live`.
//
// What this proves and how:
//   * main-session rotation drives two fresh OMP *processes* over one shared
//     state file, and the evidence is the `model`/`provider` OMP recorded on the
//     assistant turn — not the extension's own log line, which only reports what
//     the extension asked for.
//   * the starting model is pinned to route A while the pool rotates [B, A], so
//     each run has to *change* the model to pass, and the two runs must differ
//     from each other. Pinning also guarantees no unconfigured model is called.
//
// Anything unproven is reported as skipped with the reason, never as a pass.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createIsolatedEnv,
  diffManifests,
  hashOwnerConfig,
  sweepAbandonedRoots,
  writeRunManifest,
} from "./isolated-env.mjs";
import { findSessionFiles, parseJsonOutput, readTranscript, runOmp } from "./omp-runner.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
/** The provider's live catalog. Its `isFree` flag is the authoritative free marker. */
const KILO_CATALOG_URL = "https://api.kilo.ai/api/gateway/models";
const results = [];
let failures = 0;

function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (status === "fail") failures += 1;
}

/**
 * Free routes, from two sources that must agree.
 *
 * OMP's own registry advertises `:free` selectors the Kilo gateway then rejects
 * with 404 — the catalog is optimistic about ids. So the registry alone is not
 * enough: the provider's live catalog decides, and `isFree` there is the only
 * authoritative statement that a route is zero-cost. Pricing in OMP's registry
 * is `unknown` for every zero-cost entry, which is why it cannot be used alone
 * either.
 *
 * Two further filters, both learned the hard way:
 *   * the id must carry the provider's explicit `:free` marker. Zero price with
 *     a different name also matches routing entries such as `reflection/beam-free`
 *     and `kilo-auto/free`, which forward wherever they like and are not pinned
 *     round-robin members.
 *   * small/fast ids are preferred. A free tier queues, so a 550B route does not
 *     answer a one-word prompt inside any sane test budget.
 *
 * `OMP_LIVE_ROUTES=<a>,<b>` pins the pair; each is still validated here.
 */
async function discoverFreeRoutes(env) {
  const registryRes = await runOmp(["models", "--json", "--no-extensions"], { env, timeoutMs: 60_000 });
  const registryModels = parseJsonOutput(registryRes.stdout)?.models;
  if (!Array.isArray(registryModels)) {
    return { routes: [], reason: `could not read OMP's model list (exit ${registryRes.code})` };
  }
  const known = new Set(
    registryModels.filter((m) => m && typeof m.selector === "string").map((m) => m.selector),
  );

  let catalog;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(KILO_CATALOG_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalog = (await res.json())?.data;
  } catch (err) {
    return { routes: [], reason: `could not read the provider catalog: ${err.message}` };
  }
  if (!Array.isArray(catalog)) return { routes: [], reason: "provider catalog was not a list" };

  const eligible = new Map();
  for (const entry of catalog) {
    if (!entry || entry.isFree !== true) continue;
    if (typeof entry.id !== "string" || !entry.id.endsWith(":free")) continue;
    if (entry.pricing && (Number(entry.pricing.prompt) !== 0 || Number(entry.pricing.completion) !== 0)) {
      continue;
    }
    const selector = `kilo/${entry.id}`;
    if (!known.has(selector)) continue; // OMP cannot resolve what its registry lacks
    eligible.set(selector, entry);
  }

  const override = (process.env.OMP_LIVE_ROUTES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (override.length > 0) {
    const bad = override.filter((s) => !eligible.has(s));
    if (bad.length > 0) {
      return { routes: [], reason: `OMP_LIVE_ROUTES not free+resolvable: ${bad.join(", ")}` };
    }
    return { routes: [...new Set(override)].slice(0, 2), reason: "" };
  }

  const speedScore = (id) => {
    const s = id.toLowerCase();
    if (/lightning|flash|nano|tiny/.test(s)) return 0;
    if (/mini|small|free/.test(s)) return 1;
    return 2;
  };
  // A reasoning route will happily emit a long chain of thought for a one-word
  // prompt, and free tiers queue, so a reasoning model is a poor choice for the
  // pinned start. Prefer plain chat routes first.
  const isReasoning = (entry) =>
    Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("reasoning");
  const ranked = [...eligible.keys()].sort((a, b) => {
    const ra = isReasoning(eligible.get(a)) ? 1 : 0;
    const rb = isReasoning(eligible.get(b)) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const sa = speedScore(a);
    const sb = speedScore(b);
    if (sa !== sb) return sa - sb;
    const ca = eligible.get(a).context_length ?? 0;
    const cb = eligible.get(b).context_length ?? 0;
    if (cb !== ca) return cb - ca;
    return a.localeCompare(b);
  });
  return {
    routes: ranked.slice(0, 2),
    reason: ranked.length < 2 ? "fewer than two routes both free and resolvable" : "",
  };
}

async function main() {
  const beforeHashes = hashOwnerConfig();
  const swept = sweepAbandonedRoots();
  if (swept.length > 0) {
    console.log(`swept ${swept.length} abandoned run root(s) from earlier interrupted runs`);
  }

  const probe = await discoverFreeRoutes(process.env);
  if (probe.routes.length < 2) {
    // Report the diagnostic and stop. Nothing was run, so there is nothing to
    // clean up and no manifest to leave behind.
    record("free route discovery", "skip", probe.reason || "fewer than two free routes");
    console.log(`\n${results.length - failures}/${results.length} checks passed`);
    process.exit(0);
  }
  const [routeB, routeA] = probe.routes;
  record("free route discovery", "pass", `pinned start ${routeA}, pool rotates [${routeB}, ${routeA}]`);

  const poolConfig = {
    pools: { default: [routeB, routeA], slow: [routeB, routeA] },
    persistCounters: true,
    enableMainSessionRotation: true,
    mainSessionRole: "default",
  };
  const isolated = createIsolatedEnv({ poolConfig, repoRoot, label: "main-rotation" });
  const prompt = "Reply with exactly: OK";

  try {
    // --- main-session rotation across two fresh processes -------------------
    const expected = [routeB, routeA];
    for (let i = 0; i < expected.length; i += 1) {
      const res = await runOmp(
        [...isolated.ompArgs, "--model", routeA, "--no-tools", "-p", prompt],
        { cwd: isolated.workDir, env: isolated.env, timeoutMs: 240_000 },
      );
      if (res.timedOut) {
        const tail = res.stderr.trim().split(/\r?\n/).slice(-2).join(" | ");
        record(`main run ${i + 1}`, "fail", `timed out; stderr: ${tail || "(none)"}`);
        continue;
      }
      if (res.code !== 0) {
        record(`main run ${i + 1}`, "fail", `exit ${res.code}: ${res.stderr.trim().slice(0, 300)}`);
        continue;
      }
      const sessions = findSessionFiles(isolated.sessionDir);
      if (sessions.length === 0) {
        record(`main run ${i + 1}`, "fail", "no session transcript was written");
        continue;
      }
      const transcript = readTranscript(sessions[0].file);
      const actual = transcript.assistantModels[0];
      if (actual === undefined) {
        record(`main run ${i + 1}`, "fail", "assistant turn recorded no model");
        continue;
      }
      if (actual !== expected[i]) {
        record(`main run ${i + 1}`, "fail", `expected ${expected[i]}, OMP ran ${actual}`);
        continue;
      }
      record(`main run ${i + 1}`, "pass", `ran on ${actual}`);
    }

    // --- resuming must not re-rotate ---------------------------------------
    // Asserted on the model that actually ran rather than on the absence of a
    // `model_change` entry: the host records its own entries for a resumed
    // session, so absence would be a false signal either way.
    const second = await runOmp(
      [...isolated.ompArgs, "--continue", "--model", routeA, "--no-tools", "-p", prompt],
      { cwd: isolated.workDir, env: isolated.env, timeoutMs: 240_000 },
    );
    if (second.code === 0) {
      const sessions = findSessionFiles(isolated.sessionDir);
      const transcript = sessions.length > 0 ? readTranscript(sessions[0].file) : undefined;
      const turns = transcript?.assistantModels ?? [];
      const last = turns[turns.length - 1];
      record(
        "resuming does not re-rotate the main model",
        last === routeA ? "pass" : "fail",
        last === routeA
          ? `resumed turn ran on the restored ${routeA}`
          : `resumed turn ran on ${last ?? "(none)"}, a rotation would have applied ${routeB}`,
      );
    } else {
      record("resuming does not re-rotate the main model", "skip", `exit ${second.code}`);
    }

    // --- role rotation: one real subagent bound to an unpinned role --------
    // The bundled `reviewer` agent declares `model: ["@slow"]`, so spawning it
    // routes the `slow` pool. The trigger is model-driven — OMP exposes no
    // "spawn agent X" command — so a parent that declines to delegate reports
    // skip, never pass. The assertion is not model-dependent: the child's own
    // transcript records the model that actually ran.
    const delegate = await runOmp(
      [
        ...isolated.ompArgs,
        "--model",
        routeA,
        "-p",
        'Call the task tool exactly once, with agent "reviewer" and prompt "Reply with exactly: OK". Then stop.',
      ],
      { cwd: isolated.workDir, env: isolated.env, timeoutMs: 240_000 },
    );
    const childSessions = findSessionFiles(isolated.sessionDir)
      .map((s) => readTranscript(s.file))
      .filter((t) => t.header !== undefined && t.header.parentSession !== undefined);
    if (delegate.code !== 0 || childSessions.length === 0) {
      record(
        "subagent on an unpinned role rotates",
        "skip",
        delegate.code !== 0
          ? `parent exited ${delegate.code}; no delegation observed`
          : "the parent model did not delegate; nothing to assert",
      );
    } else {
      const childModels = childSessions
        .flatMap((t) => t.assistantModels)
        .filter((m) => m.startsWith("kilo/"));
      const hit = childModels.find((m) => m === routeB || m === routeA);
      record(
        "subagent on an unpinned role rotates",
        hit === routeB ? "pass" : "fail",
        hit === undefined
          ? `no free-route subagent turn found (saw: ${childModels.join(", ") || "none"})`
          : hit === routeB
            ? `subagent ran on the role pool's first entry ${routeB}`
            : `subagent ran on ${hit}, a rotation would have applied ${routeB}`,
      );
    }

    // --- every counter asserted, not just the schema marker ----------------
    // Three fresh main sessions start in this run (run 1, run 2, and the
    // delegation run, which is itself a new main session) and one subagent
    // spawns on `slow`. Over a two-entry pool that is 0->1->0->1, so a bare
    // "version 2 exists" check would miss a role rotation that picked correctly
    // but never persisted, or a main rotation that silently stopped.
    const expectedCounters = { default: 1, slow: 1 };
    let counters;
    try {
      counters = JSON.parse(readFileSync(isolated.stateFile, "utf8")).counters;
    } catch (err) {
      counters = undefined;
    }
    const countersMatch =
      counters !== undefined &&
      Object.entries(expectedCounters).every(([role, want]) => counters[role] === want);
    record(
      "each role counter advanced as expected",
      countersMatch ? "pass" : "fail",
      countersMatch
        ? `counters ${JSON.stringify(counters)}`
        : `expected ${JSON.stringify(expectedCounters)}, got ${JSON.stringify(counters ?? "unreadable state")}`,
    );
  } finally {
    const afterHashes = hashOwnerConfig();
    const changed = diffManifests(beforeHashes, afterHashes);
    record(
      "owner configuration untouched",
      changed.length === 0 ? "pass" : "fail",
      changed.length === 0 ? "all hashes unchanged" : `changed: ${changed.join(", ")}`,
    );
    writeRunManifest(isolated, {
      phase: "complete",
      ompArgs: isolated.ompArgs,
      routes: { pinnedStart: routeA, pool: [routeB, routeA] },
      ownerConfigBefore: beforeHashes,
      ownerConfigAfter: afterHashes,
      results,
    });
    isolated.cleanup();
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`live suite crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
