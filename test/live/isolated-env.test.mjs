// Offline proof for the live suite's environment isolation.
//
// `createIsolatedEnv` must hand the OMP child a world of its own, built from
// scratch: only platform launch essentials, locale, the explicit test-supplied
// `providerEnv`, and the run's pool wiring. Marker variables planted in the
// invoking process — credentials, profile selectors, proxies — must never
// appear in the child environment, the factory must not mutate the invoking
// environment itself, and every root is removed in `finally`.
//
// `writeRunManifest` after cleanup returns undefined WITHOUT recreating the
// root: a cleaned-up run deliberately leaves no completed manifest behind.
//
// No sockets, no OMP spawn, no real credentials: everything here is local disk.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createIsolatedEnv, writeRunManifest } from "./isolated-env.mjs";

const POOL_CONFIG = { pools: { default: ["fixture/a", "fixture/b"] }, persistCounters: true };

/** Build a throwaway repo root whose `src/index.ts` exists, so the factory's entry-point guard passes. */
function makeRepoFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-live-env-fixture-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
  return root;
}

/**
 * Plant `markers` on process.env and return a restore function. Values absent
 * before planting are deleted again; existing ones are put back verbatim.
 */
function plantMarkers(markers) {
  const saved = new Map();
  for (const [key, value] of Object.entries(markers)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Ambient owner variables that must never reach the sandbox child. */
const OWNER_MARKERS = {
  KILO_API_KEY: "ambient-kilo-key",
  OPENROUTER_API_KEY: "ambient-openrouter-key",
  MISTRAL_API_KEY: "ambient-mistral-key",
  OMP_PROFILE: "owner-profile",
  PI_PROFILE: "owner-profile",
  PI_CONFIG_DIR: "owner-config-root",
  HTTP_PROXY: "http://owner-proxy.invalid:8080",
  HTTPS_PROXY: "http://owner-proxy.invalid:8080",
  NO_PROXY: "owner-no-proxy.invalid",
  ALL_PROXY: "socks5://owner-proxy.invalid:1080",
  OMP_LIVE_DOPPLER_PROJECT: "removed-source",
  OMP_LIVE_DOPPLER_CONFIG: "removed-source",
};

const PROFILE_AND_PROXY_KEYS = [
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "OMP_LIVE_DOPPLER_PROJECT",
  "OMP_LIVE_DOPPLER_CONFIG",
];

test("writeRunManifest after cleanup returns undefined without recreating the root", async () => {
  const repoFixture = makeRepoFixture();
  const isolated = createIsolatedEnv({
    poolConfig: POOL_CONFIG,
    repoRoot: repoFixture,
    label: "manifest-after-cleanup",
  });
  try {
    assert.equal(await isolated.cleanup(), true, "cleanup removes a root with no live handles");
    assert.equal(existsSync(isolated.root), false, "the root is gone before the manifest call");
    assert.equal(
      writeRunManifest(isolated, { phase: "complete", label: isolated.label }),
      undefined,
      "a cleaned-up root has nowhere to record the manifest",
    );
    assert.equal(existsSync(isolated.root), false, "the manifest call must not recreate the root");
    assert.equal(existsSync(path.join(isolated.root, "run-manifest.json")), false);
  } finally {
    await isolated.cleanup();
    rmSync(repoFixture, { recursive: true, force: true });
  }
});

test("isolation never forwards marker owner variables and keeps sandbox paths plus explicit providerEnv", async () => {
  const repoFixture = makeRepoFixture();
  const restore = plantMarkers(OWNER_MARKERS);
  let isolated;
  try {
    const envBefore = JSON.stringify({ ...process.env });
    isolated = createIsolatedEnv({
      poolConfig: POOL_CONFIG,
      repoRoot: repoFixture,
      label: "isolation",
      providerEnv: {
        // An explicit per-case dummy is the only way a credential name enters
        // the child; it must win over the ambient marker, never merge with it.
        KILO_API_KEY: "dummy-per-case-kilo-key",
        // A providerEnv attempt to redirect a sandbox path must lose: the
        // isolation paths are applied last, over everything above.
        HOME: "redirect-attempt",
        SMOKE_BASE_URL: "http://127.0.0.1:1/v1",
      },
    });

    // The factory itself must not mutate the invoking environment.
    assert.equal(
      JSON.stringify({ ...process.env }),
      envBefore,
      "createIsolatedEnv must leave process.env untouched",
    );

    const { env } = isolated;

    // Credentials: the ambient markers are absent; only the explicit dummy
    // from providerEnv is present.
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.MISTRAL_API_KEY, undefined);
    assert.equal(env.KILO_API_KEY, "dummy-per-case-kilo-key");

    // Profile and proxy markers: absent outright.
    for (const key of PROFILE_AND_PROXY_KEYS) {
      assert.equal(env[key], undefined, `${key} must not reach the child`);
    }
    assert.equal(
      env.PI_CODING_AGENT_DIR,
      isolated.agentDir,
      "the ambient profile dir is replaced by the sandbox agent dir",
    );

    // Explicit providerEnv is retained verbatim.
    assert.equal(env.SMOKE_BASE_URL, "http://127.0.0.1:1/v1");

    // Sandbox paths win over anything set above them and stay inside the root.
    assert.equal(env.HOME, isolated.homeDir);
    assert.equal(env.USERPROFILE, isolated.homeDir);
    assert.equal(env.OMP_LIVE_ROOT, isolated.root);
    assert.equal(env.OMP_MODEL_POOLS_JSON, JSON.stringify(POOL_CONFIG));
    assert.equal(env.OMP_MODEL_POOL_STATE, isolated.stateFile);
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "TEMP", "TMP"]) {
      assert.ok(env[key]?.startsWith(isolated.root), `${key} must resolve inside the sandbox root`);
    }

    // Launch essentials are inherited, and the fresh home/agent layout exists.
    assert.ok(env.PATH !== undefined || env.Path !== undefined, "PATH must be inherited so the child resolves binaries");
    assert.ok(existsSync(isolated.agentDir), "the fresh agent directory is constructed, not cloned");
  } finally {
    restore();
    if (isolated !== undefined) await isolated.cleanup();
    rmSync(repoFixture, { recursive: true, force: true });
  }
  assert.equal(existsSync(isolated.root), false, "the sandbox root is removed after the test");
});
