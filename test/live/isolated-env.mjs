// Isolated runtime for the optional live suite.
//
// Goals, in order: never mutate the owner's OMP configuration or auth store,
// keep every artifact under one removable root, and make the run auditable
// without ever printing a credential.
//
// Isolation strategy, and why it is this one:
//   * a fresh home plus a private agent directory mean the child starts with
//     no credentials at all: owner auth is never read, inherited, or copied,
//     and no owner credential state enters the child environment.
//   * `--session-dir` isolates session storage, so transcripts land in the test
//     root instead of the owner's sessions tree.
//   * a unique temp cwd keeps any per-project state in its own bucket.
//   * `--no-extensions` plus an explicit `-e` means only this extension loads.
//   * `--config` overlay plus `--no-prewalk/--no-skills/--no-rules/--no-title`
//     disable hidden work that could spend a paid model or run arbitrary setup.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The agent directory OMP is actually using.
 *
 * Not a hardcoded `~/.omp/agent`: `OMP_PROFILE`/`PI_PROFILE` relocate it under
 * `profiles/<name>/agent`, `PI_CONFIG_DIR` moves the root, and
 * `PI_CODING_AGENT_DIR` applies to the default profile only. Hashing the default
 * path would let the "owner configuration untouched" check pass while the active
 * profile's files changed. These are the same rules the extension uses.
 */
export function ownerAgentDir() {
  const omp = process.env.OMP_PROFILE;
  const rawProfile = omp !== undefined ? omp : process.env.PI_PROFILE;
  let profile;
  if (rawProfile !== undefined) {
    const trimmed = rawProfile.trim();
    profile = trimmed.length === 0 || trimmed === "default" ? undefined : trimmed;
  }
  const configured = process.env.PI_CONFIG_DIR;
  const configDirName =
    typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : ".omp";
  const root = path.join(os.homedir(), configDirName);
  if (profile !== undefined) return path.join(root, "profiles", profile, "agent");
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    const value = fromEnv.trim();
    return path.isAbsolute(value) ? value : path.resolve(value.replace(/^~/, os.homedir()));
  }
  return path.join(root, "agent");
}

/** Owner configuration files that must not change. Databases are excluded: they are live. */
export function ownerConfigFiles() {
  const agentDir = ownerAgentDir();
  return ["config.yml", "settings.json", "models.yml", "mcp.json"].map((name) => ({
    name,
    file: path.join(agentDir, name),
  }));
}

/** SHA-256 of each owner config file, or "absent". Values only; contents are never logged. */
export function hashOwnerConfig() {
  const out = {};
  for (const { name, file } of ownerConfigFiles()) {
    if (!existsSync(file)) {
      out[name] = "absent";
      continue;
    }
    out[name] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return out;
}

/** Compare two hash manifests and return the names that changed. */
export function diffManifests(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]);
}

/**
 * Build the isolated environment.
 *
 * `poolConfig` becomes `OMP_MODEL_POOLS_JSON`; `routes` are the selectors the
 * pool rotates over. Nothing here writes to the owner's agent directory.
 */
export function createIsolatedEnv({ poolConfig, repoRoot, label = "run", providerEnv = {}, overlayExtra = [] }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-live-"));
  const workDir = path.join(root, "work");
  const sessionDir = path.join(root, "sessions");
  const stateFile = path.join(root, "model-pool-state.json");
  const overlayFile = path.join(root, "overlay.yml");
  const extensionFile = path.join(repoRoot, "src", "index.ts");
  // A fresh home plus private XDG and temp dirs: the child resolves every
  // writable location against the sandbox root, never against the owner's.
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".omp", "agent");
  const tmpDir = path.join(root, "tmp");
  const xdgDirs = {
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
  };
  for (const dir of [workDir, sessionDir, homeDir, agentDir, tmpDir, ...Object.values(xdgDirs)]) {
    mkdirSync(dir, { recursive: true });
  }

  if (!existsSync(extensionFile)) {
    throw new Error(`extension entry point missing: ${extensionFile}`);
  }

  // Overlay: neutralise the owner's cost-bearing settings for this run only.
  // Written fresh each run rather than merged into anything the owner owns.
  // `overlayExtra` lines are appended verbatim after the fixed keys so a slice
  // can inject extra YAML (e.g. `modelRoles:`) without a second file.
  writeFileSync(
    overlayFile,
    [
      "# generated by test/live — isolated overlay for one live run",
      "startup:",
      "  checkUpdate: false",
      "update:",
      "  auto: false",
      "marketplace:",
      "  autoUpdate: false",
      "telemetry:",
      "  otlpExportEnabled: false",
      "prewalk:",
      "  enabled: false",
      "  auto: off",
      "advisor:",
      "  enabled: false",
      "task:",
      "  maxConcurrency: 1",
      "  batch: false",
      "  steps: false",
      "  maxRecursionDepth: 1",
      "  isolation:",
      "    enabled: false",
      "async:",
      "  enabled: false",
      "retry:",
      "  enabled: false",
      "  modelFallback: false",
      "  fallbackChains: {}",
      ...overlayExtra,
    ].join("\n"),
    "utf8",
  );

  const env = {};
  // 1. Platform launch essentials: PATH so the child resolves binaries, plus
  //    the Windows variables a spawned process cannot start cleanly without.
  //    Only these keys are inherited; nothing else from the owner's
  //    environment (credentials, routing, MCP, proxies, shell state) passes.
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // 2. Locale pass-through so child output stays readable. Anchored on both
  //    ends: LANGFUSE_* and friends must not ride on the LANG prefix.
  for (const key of Object.keys(process.env)) {
    if (/^(LANG|LANGUAGE|LC_[A-Z_]*)$/.test(key)) env[key] = process.env[key];
  }
  // 3. Test-supplied provider settings (API keys, base URLs).
  for (const [key, value] of Object.entries(providerEnv)) env[key] = value;
  // 4. Isolation paths, set last so nothing above can redirect them: HOME and
  //    USERPROFILE resolve into the sandbox, and both spellings of every
  //    XDG/TMP variable are pinned so no lookup can fall back to the owner's.
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.PI_CODING_AGENT_DIR = agentDir;
  env.XDG_CONFIG_HOME = xdgDirs.XDG_CONFIG_HOME;
  env.XDG_DATA_HOME = xdgDirs.XDG_DATA_HOME;
  env.XDG_STATE_HOME = xdgDirs.XDG_STATE_HOME;
  env.XDG_CACHE_HOME = xdgDirs.XDG_CACHE_HOME;
  env.TMPDIR = tmpDir;
  env.TEMP = tmpDir;
  env.TMP = tmpDir;
  // Points the run's own artefact writes back into the sandbox root.
  env.OMP_LIVE_ROOT = root;
  // Pool wiring for this run: the extension reads the pool set from the
  // environment, and the extension reads the pool state file location too.
  env.OMP_MODEL_POOLS_JSON = JSON.stringify(poolConfig);
  env.OMP_MODEL_POOL_STATE = stateFile;

  const ompArgs = [
    "--no-extensions",
    "-e",
    extensionFile,
    "--config",
    overlayFile,
    "--session-dir",
    sessionDir,
    "--no-prewalk",
    "--no-skills",
    "--no-rules",
    "--no-title",
    "--no-context-files",
    "--no-lsp",
    "--tools",
    "read",
  ];

  return {
    label,
    root,
    workDir,
    sessionDir,
    stateFile,
    overlayFile,
    extensionFile,
    homeDir,
    agentDir,
    env,
    ompArgs,
    /**
     * Remove this run's root, retrying briefly. Resolves true when it is gone.
     *
     * The retry is not defensive padding: the first removal reliably fails on
     * Windows because a child process handle is still closing, and the same tree
     * deletes cleanly a moment later. Without the retry, cleanup left a partial
     * root (`work/` behind) that also defeated the sweep's layout guard, so the
     * two bugs hid each other.
     */
    async cleanup() {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // Expected while handles close; the existence check below decides.
        }
        if (!existsSync(root)) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return !existsSync(root);
    },
  };
}

/** Secret-free run record, written into the root so an interrupted run is still auditable. */
export function writeRunManifest(isolated, data) {
  if (!existsSync(isolated.root)) return undefined;
  const file = path.join(isolated.root, "run-manifest.json");
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Remove roots left by earlier runs that were killed before their cleanup ran.
 *
 * A run that times out or is interrupted never reaches its `finally`, and three
 * such roots were left behind before this existed. Cleanup has to be runnable
 * after the fact, not only by the run that made the mess.
 *
 * Deliberately narrow: only `omp-live-*` directories under the OS temp dir, only
 * once they are older than an hour, and only when they carry part of the layout
 * this module creates.
 */
export function sweepAbandonedRoots({ olderThanMs = 3_600_000 } = {}) {
  const removed = [];
  let entries;
  try {
    entries = readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const entry of entries) {
    // Ownership is the exact name shape `mkdtempSync` produces for this module,
    // not a bare prefix: everything here is removed recursively, so a looser
    // test would delete a directory this suite never created.
    if (!entry.isDirectory() || !/^omp-live-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (now - statSync(full).mtimeMs < olderThanMs) continue; // possibly a run in flight
      const ours =
        existsSync(path.join(full, "work")) || existsSync(path.join(full, "sessions"));
      if (!ours) continue;
      rmSync(full, { recursive: true, force: true });
      if (!existsSync(full)) removed.push(full);
    } catch {
      // Best effort.
    }
  }
  return removed;
}
