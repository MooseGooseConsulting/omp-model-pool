// omp-model-pool — per-role round-robin model cycling for oh-my-pi.
//
// Primary hook: `before_subagent_spawn` (parent session, once per new child).
// Secondary hook: `session_start` for main sessions only (`ctx.agent.kind === "main"`).
//
// Keying: bare role name after stripping a single leading "@" from
// `event.modelRole`. `agent` / `invocationKind` are observed for logging only
// and never affect the counter key.
//
// Counters are module-level (`Record<string, number>`) so every session bound
// in this process shares them; separate OMP processes do not share counters.
// Parallel spawns advance in handler-execution order (nondeterministic under
// concurrency). Counters are in-memory only and reset on restart.
//
// Model validation reuses core resolution: every pool entry goes through
// `ctx.models.resolve(spec)` and must also appear in `ctx.models.list()`.
// Unresolvable / unauthenticated entries are filtered; an emptied pool leaves
// the spawn unmodified (fail open) unless a strict block policy is configured.
//
// Returned single `model` replaces the spawn's attempt-ordered patterns while
// keeping role identity, so core `retry.fallbackChains` / prewalk / advisor
// semantics are preserved, not replaced.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Minimal structural types (kept local so the extension stays zero-dependency
// and loadable without installing OMP packages).
// ---------------------------------------------------------------------------

interface ModelLike {
  id?: unknown;
  provider?: unknown;
  [key: string]: unknown;
}

interface ModelsQuery {
  list(): ModelLike[];
  current(): ModelLike | undefined;
  resolve(spec: string): ModelLike | undefined;
  family?(model: ModelLike): string;
}

interface BeforeSubagentSpawnEvent {
  type: "before_subagent_spawn";
  agent: string;
  invocationKind: string;
  modelRole?: string;
  patterns: string[];
  spawnKey?: string;
}

interface BeforeSubagentSpawnResult {
  model?: string | string[];
  block?: boolean;
  reason?: string;
  note?: string;
}

interface SessionStartEvent {
  type: string;
  [key: string]: unknown;
}

interface ExtensionContextLike {
  agent?: { kind?: unknown; name?: unknown; id?: unknown };
  models?: ModelsQuery;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
  /**
   * Read-only session manager. `getSessionFile()` reports the durable
   * transcript path, which distinguishes a loaded session from a new one;
   * `getEntries()` is the fallback when no path is exposed.
   */
  sessionManager?: { getEntries?: () => unknown; getSessionFile?: () => unknown };
  cwd?: string;
  [key: string]: unknown;
}

interface ExtensionApiLike {
  on(
    event: "before_subagent_spawn",
    handler: (
      event: BeforeSubagentSpawnEvent,
      ctx: ExtensionContextLike,
    ) => BeforeSubagentSpawnResult | undefined | Promise<BeforeSubagentSpawnResult | undefined>,
  ): void;
  on(
    event: "session_start",
    handler: (event: SessionStartEvent, ctx: ExtensionContextLike) => void | Promise<void>,
  ): void;
  on(event: string, handler: (...args: never[]) => unknown): void;
  setModel?(model: string): void | Promise<void>;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  [key: string]: unknown;
}

export interface ModelPoolConfig {
  /** Pools keyed by bare role name (`slow`, `default`, …). Values are selectors in cycle order. */
  pools: Record<string, string[]>;
  /** Role used for main-session rotation (bare name, no "@"). Default `"default"`. */
  mainSessionRole?: string;
  /** Disable the `session_start` main-session rotation while keeping subagent cycling. */
  enableMainSessionRotation?: boolean;
  /**
   * Empty-pool policy. `false` (default) leaves the spawn unmodified and logs;
   * `true` blocks every empty-pool spawn; an array blocks only the listed roles.
   */
  strict?: boolean | string[];
  /**
   * Opt-in cross-process counter persistence. `false` (default) keeps the
   * in-memory counters only, so every OMP process starts its own cycle.
   * `true` reads and writes the shared state file under a cross-process lock,
   * so sequential `omp` processes (each a fresh OS process) continue the cycle.
   */
  persistCounters?: boolean;
  /** State file for `persistCounters`. Default: `OMP_MODEL_POOL_STATE` or `~/.omp/agent/model-pool-state.json`. */
  stateFile?: string;
}

// ---------------------------------------------------------------------------
// Module-level shared state (in-process round-robin counters).
// ---------------------------------------------------------------------------

const counters: Record<string, number> = Object.create(null);

/** State file name under the OMP agent dir when no explicit/env path is given. */
const DEFAULT_STATE_FILE = "model-pool-state.json";
/**
 * Persisted schema version. v1 stored a count into the *filtered* list of
 * authenticated entries; v2 stores an index into the configured pool. The two
 * are not translatable (v1 has no record of which entries were filtered), so a
 * v1 file is rejected rather than reinterpreted — see `parseState`.
 */
const SCHEMA_VERSION = 2;
/** The schema the earlier release wrote; recognized so it can be replaced, not merely rejected. */
const LEGACY_SCHEMA_VERSION = 1;
/** Cross-process lock acquisition budget (spawn-critical section is milliseconds). */
const LOCK_TIMEOUT_MS = 6000;
/** A lock older than this is assumed abandoned by a crashed process. */
const STALE_LOCK_MS = 120_000;

const activeConfig: Required<Omit<ModelPoolConfig, "strict">> & { strict: boolean | string[] } = {
  pools: Object.create(null),
  mainSessionRole: "default",
  enableMainSessionRotation: true,
  strict: false,
  persistCounters: false,
  stateFile: resolveStateFilePath(),
};

/** Replace the active pool configuration (used by the factory and tests). */
export function configurePools(next: ModelPoolConfig | undefined | null): void {
  const normalized = normalizeConfig(next);
  activeConfig.pools = normalized.pools;
  activeConfig.mainSessionRole = normalized.mainSessionRole;
  activeConfig.enableMainSessionRotation = normalized.enableMainSessionRotation;
  activeConfig.strict = normalized.strict;
  activeConfig.persistCounters = normalized.persistCounters;
  activeConfig.stateFile = normalized.stateFile;
}

/** Read-only snapshot of the active pools (tests / diagnostics). */
export function getPools(): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null);
  for (const [k, v] of Object.entries(activeConfig.pools)) out[k] = [...v];
  return out;
}

/** Read-only snapshot of the round-robin counters (tests / diagnostics). */
export function getCounters(): Record<string, number> {
  return { ...counters };
}

/** Reset all round-robin counters (tests; mirrors an OMP restart). */
export function resetCounters(): void {
  for (const k of Object.keys(counters)) delete counters[k];
}

// ---------------------------------------------------------------------------
// Opt-in cross-process counter persistence.
//
// Counters normally live in memory, so each OMP process starts its own cycle.
// When `persistCounters` is on, the pick is a read-modify-write against a
// shared JSON state file, serialized by an atomic-directory lock so parallel
// processes do not double-pick. Every failure here is fail-open: the caller
// logs and falls back to the in-memory counter, and a malformed state file is
// never silently reset (it is left for the operator to repair or delete).
// ---------------------------------------------------------------------------

/**
 * The active OMP profile name, or undefined for the default profile.
 *
 * Mirrors OMP's own resolution: `OMP_PROFILE` is canonical and wins even when
 * it is set but empty — an explicitly-empty value selects the default profile
 * rather than inheriting the legacy `PI_PROFILE` — and `PI_PROFILE` is the
 * legacy fallback consulted only when `OMP_PROFILE` is undefined. `default`
 * and whitespace select the default profile too.
 */
function activeProfile(): string | undefined {
  const omp = process.env["OMP_PROFILE"];
  const raw = omp !== undefined ? omp : process.env["PI_PROFILE"];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 || trimmed === "default" ? undefined : trimmed;
}

/**
 * OMP's agent dir for the active profile.
 *
 * Mirrors OMP's own resolution rather than reconstructing only the default
 * case. Getting this wrong is not cosmetic: under a named profile a
 * default-only path makes two profiles silently share one counter file, and
 * writes state into a profile the operator is not running even though "a
 * profile sees only its own OMP config".
 *
 * - config root is `~/<PI_CONFIG_DIR or .omp>`
 * - a named profile relocates the agent dir to `<root>/profiles/<name>/agent`
 * - `PI_CODING_AGENT_DIR` applies to the default profile only; a named profile
 *   ignores it
 *
 * XDG relocation (`$XDG_*_HOME/omp`) is deliberately not followed: OMP applies
 * it per category and only when that category already contains `omp/`, which
 * is more surface than this extension should re-derive. Set `stateFile`
 * explicitly on a host that relocated its agent directory.
 */
function agentDir(): string {
  const configured = process.env["PI_CONFIG_DIR"];
  const configDirName =
    typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : ".omp";
  const root = path.join(os.homedir(), configDirName);
  const profile = activeProfile();
  if (profile !== undefined) return path.join(root, "profiles", profile, "agent");
  const fromEnv = process.env["PI_CODING_AGENT_DIR"];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return path.resolve(expandTilde(fromEnv.trim()));
  return path.join(root, "agent");
}

/** Expand a leading `~`. `path.resolve` does not, so a literal `~` directory would be created. */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the state file: explicit option > `OMP_MODEL_POOL_STATE` > agent dir.
 * A relative path (and a bare `~`) resolves against the agent dir, never the
 * process CWD, so two processes started from different directories still share.
 */
export function resolveStateFilePath(explicit?: string): string {
  const base = agentDir();
  const fromOption = typeof explicit === "string" ? explicit.trim() : "";
  if (fromOption.length > 0) {
    const expanded = expandTilde(fromOption);
    return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
  }
  const fromEnv = process.env["OMP_MODEL_POOL_STATE"];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    const expanded = expandTilde(fromEnv.trim());
    return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
  }
  return path.join(base, DEFAULT_STATE_FILE);
}

/**
 * Read outcome. `invalid` covers malformed JSON, a wrong-shaped doc and an
 * unrecognized version: those are preserved untouched, because destroying a
 * file we do not understand risks losing something we did not anticipate.
 * `legacy-v1` is different — we know exactly what it is and that its cursor
 * cannot be translated — so it is replaced instead.
 */
type StateRead =
  | { kind: "ok"; counters: Record<string, number> }
  | { kind: "legacy-v1" }
  | { kind: "invalid" };

/**
 * Parse `{ version: 2, counters: { role: index } }`.
 * A version-1 doc reports `legacy-v1`: v1 held a count into the filtered
 * eligible list, v2 an index into the configured pool, and a v1 file carries no
 * record of which entries were filtered at write time. Translating it would be
 * a guess that silently misphases the rotation, so the cursor restarts — but
 * the file is *replaced* rather than left in place, or `persistCounters` would
 * reject the same file on every start and never write v2 state again.
 */
function parseState(raw: string): StateRead {
  let obj: unknown;
  try {
    obj = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "invalid" };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return { kind: "invalid" };
  const record = obj as Record<string, unknown>;
  if (record["version"] === LEGACY_SCHEMA_VERSION) return { kind: "legacy-v1" };
  // Read-side schema guard: only a schema we understand may be used.
  if (record["version"] !== SCHEMA_VERSION) return { kind: "invalid" };
  const rawCounters = record["counters"];
  if (rawCounters === null || typeof rawCounters !== "object" || Array.isArray(rawCounters)) {
    return { kind: "invalid" };
  }
  const out: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(rawCounters as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return { kind: "invalid" };
    out[key] = value;
  }
  return { kind: "ok", counters: out };
}

/**
 * Read counters from disk. A missing file reads as empty. A file we cannot
 * interpret throws, so the caller fails open and leaves it untouched; a
 * recognized legacy file is reported so the caller can replace it.
 */
function readPersistedCounters(file: string): { counters: Record<string, number>; legacy: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { counters: Object.create(null), legacy: false };
    }
    throw err;
  }
  const parsed = parseState(raw);
  if (parsed.kind === "invalid") throw new Error(`invalid model-pool state at ${file}`);
  if (parsed.kind === "legacy-v1") return { counters: Object.create(null), legacy: true };
  return { counters: parsed.counters, legacy: false };
}

/**
 * Move a recognized legacy state file aside before fresh state is written over
 * it, so the operator's file stays inspectable. Best-effort: if the backup
 * cannot be made, the fresh write still restores persistence.
 */
function quarantineLegacyState(file: string): string {
  const backup = `${file}.v1.bak`;
  try {
    fs.rmSync(backup, { force: true });
    fs.renameSync(file, backup);
  } catch {
    // Best-effort only.
  }
  return backup;
}

/** Write the state via a unique temp file + atomic rename (mode 0600). */
function writeStateAtomic(file: string, next: Record<string, number>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: SCHEMA_VERSION, counters: next }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Temp cleanup is best-effort.
    }
  }
}

/** Sleep helper used only for lock-contention backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is the lock's recorded owner still running?
 * `true` alive, `false` provably gone (ESRCH), `undefined` unknown/unreadable.
 * Only a provably-gone owner makes a lock reclaimable, so a live-but-slow
 * holder can never lose its lock to a timeout.
 */
function lockOwnerAlive(lock: string): boolean | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(lock, "owner"), "utf8");
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw.trim().split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

/**
 * Take an abandoned lock before deleting it.
 *
 * The lock directory is renamed to a unique tombstone — an atomic claim, so
 * only one contender can win — and the owner is re-verified on the artifact we
 * now hold. A live holder is never deleted: at worst its lock is renamed and
 * restored. An ownerless lock (a crash between `mkdir` and the ownership
 * stamp) is reclaimable only once it is older than `STALE_LOCK_MS`.
 */
function reclaimAbandonedLock(lock: string): boolean {
  const ownerState = lockOwnerAlive(lock);
  if (ownerState !== false) {
    if (ownerState === true) return false; // live holder
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs <= STALE_LOCK_MS) return false;
    } catch {
      return false; // vanished or unreadable: let the next loop iteration retry
    }
  }
  const tomb = `${lock}.abandoned.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(lock, tomb);
  } catch {
    return false; // another contender claimed it first
  }
  if (lockOwnerAlive(tomb) === true) {
    // A live holder slipped in between the check and the rename: put it back.
    try {
      fs.renameSync(tomb, lock);
    } catch {
      // Canonical path stays free; the holder's own release is token-guarded.
    }
    return false;
  }
  try {
    fs.rmSync(tomb, { recursive: true, force: true });
  } catch {
    // Best-effort: an undeletable tombstone is inert.
  }
  return true;
}

/** Run `fn` while holding an atomic-directory lock; abandoned locks are reclaimed. */
async function withStateLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const owner = path.join(lock, "owner");
  const token = `${process.pid}.${Date.now()}.${randomUUID()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (reclaimAbandonedLock(lock)) continue;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for model-pool lock ${lock}`);
      await sleep(20);
    }
  }
  // Stamping ownership is part of acquiring: without it we did not acquire, so
  // an ownerless lock directory always means a crashed acquisition.
  try {
    fs.writeFileSync(owner, token, { mode: 0o600 });
  } catch (err) {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of our own unclaimed lock.
    }
    throw err;
  }
  try {
    return fn();
  } finally {
    // Release only a lock we still own. If ours was reclaimed as abandoned and
    // a new holder took it, deleting that lock would admit a third writer.
    try {
      if (fs.readFileSync(owner, "utf8").trim() === token) fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // Unverifiable: leave it for the abandoned-lock reclaimer.
    }
  }
}

/**
 * Atomically select and advance the role cursor in the shared state file.
 * The cursor indexes the configured pool and is stored modulo its length, so a
 * shared file keeps one meaning across processes. Nothing eligible means no
 * write, so the cursor is not consumed.
 */
function advancePersisted(
  roleKey: string,
  poolLength: number,
  eligible: boolean[],
  file: string,
): Promise<{ index: number; replacedLegacy: boolean } | undefined> {
  return withStateLock(file, () => {
    const read = readPersistedCounters(file);
    if (read.legacy) quarantineLegacyState(file);
    const persisted = read.counters;
    const start = poolLength === 0 ? 0 : (persisted[roleKey] ?? 0) % poolLength;
    for (let offset = 0; offset < poolLength; offset++) {
      const index = (start + offset) % poolLength;
      if (eligible[index] !== true) continue;
      persisted[roleKey] = (index + 1) % poolLength;
      writeStateAtomic(file, persisted);
      return { index, replacedLegacy: read.legacy };
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Config normalization + loading.
// ---------------------------------------------------------------------------

/** Strip one leading "@" and surrounding whitespace; empty string when blank. */
export function normalizeRoleKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

/** Coerce a config value to a list of non-empty trimmed selector strings. */
function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Normalize any accepted config shape (nested `pools` or flat map) into the internal form. */
function normalizeConfig(raw: ModelPoolConfig | undefined | null): {
  pools: Record<string, string[]>;
  mainSessionRole: string;
  enableMainSessionRotation: boolean;
  strict: boolean | string[];
  persistCounters: boolean;
  stateFile: string;
} {
  const pools: Record<string, string[]> = Object.create(null);
  const rawPools: unknown = raw?.pools ?? raw;
  if (rawPools !== null && typeof rawPools === "object" && !Array.isArray(rawPools)) {
    for (const [k, v] of Object.entries(rawPools as Record<string, unknown>)) {
      // Skip the wrapper-level option keys when a flat config is passed.
      if (
        raw?.pools === undefined &&
        (k === "mainSessionRole" ||
          k === "enableMainSessionRotation" ||
          k === "strict" ||
          k === "persistCounters" ||
          k === "stateFile")
      ) {
        continue;
      }
      const key = normalizeRoleKey(k);
      if (key.length === 0) continue;
      const list = normalizeStringList(v);
      if (list.length > 0) pools[key] = list;
    }
  }
  const mainSessionRole = normalizeRoleKey(raw?.mainSessionRole ?? "default") || "default";
  return {
    pools,
    mainSessionRole,
    enableMainSessionRotation: raw?.enableMainSessionRotation ?? true,
    strict: raw?.strict ?? false,
    // Opt-in must be exactly boolean true: a stray `"false"` string would be
    // truthy and would silently start writing a shared state file.
    persistCounters: raw?.persistCounters === true,
    stateFile: resolveStateFilePath(raw?.stateFile),
  };
}

/** Read and parse a JSON file; `undefined` on any read or parse failure. */
function readJsonFileSync(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Load initial config from env / file. Precedence: inline JSON > file > {}. */
function loadConfigFromEnv(): ModelPoolConfig {
  const inline = process.env["OMP_MODEL_POOLS_JSON"];
  if (inline !== undefined && inline.trim().length > 0) {
    try {
      const parsed = JSON.parse(inline) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Pass through unchanged: a flat map keeps its option keys
        // (persistCounters, stateFile, …) at the top level, where
        // normalizeConfig reads them. Wrapping it as `pools` would hide them.
        return parsed as ModelPoolConfig;
      }
    } catch {
      // Fall through to file / empty on invalid JSON; never throw at load.
    }
  }
  const filePath = process.env["OMP_MODEL_POOL_CONFIG"];
  if (filePath !== undefined && filePath.trim().length > 0) {
    const resolved = path.resolve(filePath.trim());
    const parsed = readJsonFileSync(resolved);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ModelPoolConfig;
    }
  }
  return { pools: Object.create(null) };
}

// ---------------------------------------------------------------------------
// Core helpers.
// ---------------------------------------------------------------------------

/** Log through `pi.logger`, swallowing any logger failure: logging must never break a spawn. */
function safeLog(
  pi: ExtensionApiLike,
  level: "info" | "warn" | "error" | "debug",
  ...args: unknown[]
): void {
  try {
    pi.logger?.[level]?.(...args);
  } catch {
    // Logging must never break a spawn.
  }
}

/** Does the configured `strict` policy cover this role? */
function isStrictForRole(roleKey: string): boolean {
  const { strict } = activeConfig;
  if (strict === true) return true;
  if (Array.isArray(strict)) return strict.map((r) => normalizeRoleKey(r)).includes(roleKey);
  return false;
}

/** `provider/id` identity for a resolved model; `""` when it carries no id. */
function modelIdentity(m: ModelLike): string {
  const provider = typeof m.provider === "string" && m.provider.length > 0 ? `${m.provider}/` : "";
  return typeof m.id === "string" && m.id.length > 0 ? `${provider}${m.id}` : "";
}

/** Per-entry availability, parallel to the configured pool. */
interface PoolAvailability {
  /** `eligible[i]` answers whether configured entry `i` may be used right now. */
  eligible: boolean[];
  /** How many entries are eligible. */
  count: number;
  /** False when the model registry could not be read at all. */
  registryReadable: boolean;
}

/**
 * Decide, per configured pool entry, whether it may be used right now.
 *
 * The result is parallel to the configured pool so the round-robin cursor can
 * stay an index into the *configured* list: an entry that is temporarily
 * unavailable is skipped without re-phasing the rotation. Modding a filtered
 * list instead shifts every cycle whenever availability changes, which emits a
 * duplicate pick at the transition.
 *
 * `registryReadable` distinguishes "the model registry says none of these are
 * authenticated" (a real empty pool) from "we could not read the registry at
 * all" (a transient host/registry failure). Only the former may hard-block
 * under `strict`; the latter always fails open.
 */
function filterAvailable(selectors: string[], models: ModelsQuery | undefined): PoolAvailability {
  const eligible = selectors.map(() => false);
  if (models === undefined) return { eligible, count: 0, registryReadable: false };
  let listed: ModelLike[];
  try {
    listed = models.list() ?? [];
  } catch {
    return { eligible, count: 0, registryReadable: false };
  }
  const identities = new Set<string>();
  for (const m of listed) {
    const id = modelIdentity(m);
    if (id.length > 0) identities.add(id);
  }
  let count = 0;
  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i] as string;
    let resolved: ModelLike | undefined;
    try {
      resolved = models.resolve(selector);
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined || resolved === null) continue;
    const id = modelIdentity(resolved);
    // Membership is by canonical identity when known; a resolved model without
    // an id still counts if resolve() itself succeeded and the list is empty
    // (hosts that report no authenticated models yet still resolve aliases).
    if (id.length > 0 && !identities.has(id) && listed.length > 0) continue;
    eligible[i] = true;
    count++;
  }
  return { eligible, count, registryReadable: true };
}

/**
 * Advance the role cursor to the next eligible entry of the *configured* pool.
 * The cursor is an index into that pool, stored modulo its length, so it stays
 * bounded and an unavailable entry is skipped without re-phasing the rotation.
 * Returns undefined when nothing is eligible (the cursor is not consumed).
 */
function pickRoundRobin(
  roleKey: string,
  pool: string[],
  eligible: boolean[],
): { picked: string; index: number } | undefined {
  const start = pool.length === 0 ? 0 : (counters[roleKey] ?? 0) % pool.length;
  for (let offset = 0; offset < pool.length; offset++) {
    const index = (start + offset) % pool.length;
    if (eligible[index] !== true) continue;
    counters[roleKey] = (index + 1) % pool.length;
    return { picked: pool[index] as string, index };
  }
  return undefined;
}

/**
 * Pick for a role, honoring `persistCounters`. A persistence failure logs and
 * falls back to the in-memory counter (fail open) rather than aborting a spawn.
 */
async function pickForRole(
  pi: ExtensionApiLike,
  roleKey: string,
  pool: string[],
  availability: PoolAvailability,
): Promise<{ picked: string; index: number; persisted: boolean } | undefined> {
  if (!activeConfig.persistCounters) {
    const pick = pickRoundRobin(roleKey, pool, availability.eligible);
    return pick === undefined ? undefined : { ...pick, persisted: false };
  }
  try {
    const picked = await advancePersisted(roleKey, pool.length, availability.eligible, activeConfig.stateFile);
    if (picked === undefined) return undefined;
    if (picked.replacedLegacy) {
      safeLog(
        pi,
        "warn",
        `[model-pool] replaced a version-1 state file at ${activeConfig.stateFile} (cursor semantics changed); ` +
          `the old file is kept at ${activeConfig.stateFile}.v1.bak and rotation continued from a fresh cursor`,
      );
    }
    counters[roleKey] = (picked.index + 1) % pool.length; // mirror for diagnostics/tests
    return { picked: pool[picked.index] as string, index: picked.index, persisted: true };
  } catch (err) {
    safeLog(
      pi,
      "warn",
      `[model-pool] persisted counter read/write failed; using in-memory counters: ${err instanceof Error ? err.message : String(err)}`,
    );
    const pick = pickRoundRobin(roleKey, pool, availability.eligible);
    return pick === undefined ? undefined : { ...pick, persisted: false };
  }
}

/** Human-readable routing note surfaced in the task UI. */
function describePick(roleKey: string, picked: string, index: number, total: number): string {
  return `pool ${roleKey}[${index + 1}/${total}]: ${picked}`;
}

/**
 * Does this entry set already contain a conversational turn?
 *
 * A loaded session always has at least one user or assistant message, while a
 * genuinely *new* session legitimately holds plenty of non-conversational
 * entries by the time this handler runs: `session_init`, title/mode/model
 * changes, usage markers, and — the case that matters — whatever a preceding
 * `session_start` handler appended via `pi.appendEntry`, which produces a
 * `custom` entry. OMP runs lifecycle handlers sequentially in extension order,
 * so counting entries would let an unrelated extension silently suppress
 * rotation on a new session.
 */
function hasConversationTurn(entries: unknown[]): boolean {
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record["type"] !== "message") continue;
    const message = record["message"];
    if (message === null || typeof message !== "object") continue;
    const role = (message as Record<string, unknown>)["role"];
    if (role === "user" || role === "assistant") return true;
  }
  return false;
}

/**
 * Does the session already have its transcript in durable storage?
 * `true` present, `false` absent, `undefined` when the host exposes no path.
 *
 * This is the load signal, because OMP's session persistence is lazy: the JSONL
 * is written only once the history holds an assistant message, or an explicit
 * `ensureOnDisk()` forces it — which is what `/new` does, precisely to preserve
 * an empty session boundary across terminals. So a *resumed* session's file is
 * already there when this handler runs, while a fresh session's
 * `getSessionFile()` is an allocated path that leads nowhere.
 */
function sessionFileExists(manager: { getSessionFile?: () => unknown }): boolean | undefined {
  if (typeof manager.getSessionFile !== "function") return undefined;
  try {
    const file = manager.getSessionFile();
    if (typeof file !== "string" || file.length === 0) return undefined;
    return fs.existsSync(file);
  } catch {
    return undefined;
  }
}

/** Whether the entry list holds a conversational turn; `undefined` if it cannot be read. */
function sessionHasConversationTurn(manager: { getEntries?: () => unknown }): boolean | undefined {
  if (typeof manager.getEntries !== "function") return undefined;
  try {
    const entries = manager.getEntries();
    if (!Array.isArray(entries)) return undefined;
    return hasConversationTurn(entries);
  } catch {
    return undefined;
  }
}

/**
 * Is this `session_start` a genuinely new session?
 * `true` new, `false` a loaded session whose transcript was restored,
 * `undefined` when the host exposes too little to tell. Only `true` rotates: an
 * unknown answer must never risk overriding a model that OMP just restored.
 *
 * Two signals both mean "loaded": the transcript already exists on disk, or the
 * entries already hold a conversational turn. The file is the decisive one — a
 * session saved by `/new` with a model picked but no prompt yet holds only
 * `session_init`/`model_change` metadata and no turn, and resuming it restores
 * that model, so keying on turns alone would clobber it. Neither signal firing
 * is only "new" when at least one was actually observable.
 */
function sessionFreshness(ctx: ExtensionContextLike): boolean | undefined {
  const manager = ctx.sessionManager;
  if (manager === undefined) return undefined;
  const hasFile = sessionFileExists(manager);
  const hasTurn = sessionHasConversationTurn(manager);
  if (hasFile === true || hasTurn === true) return false;
  if (hasFile === undefined && hasTurn === undefined) return undefined;
  return true;
}

// ---------------------------------------------------------------------------
// Event handlers.
// ---------------------------------------------------------------------------

/** `before_subagent_spawn` handler: rotate the model for a role-keyed pool. */
function handleBeforeSubagentSpawn(
  pi: ExtensionApiLike,
  event: BeforeSubagentSpawnEvent,
  ctx: ExtensionContextLike,
): BeforeSubagentSpawnResult | undefined | Promise<BeforeSubagentSpawnResult | undefined> {
  try {
    // Explicit per-dispatch pin (no role alias) — preserve the deliberate pin.
    if (event.modelRole === undefined || event.modelRole === null) {
      safeLog(pi, "debug", `[model-pool] passthrough: explicit model pin for agent=${event.agent ?? "?"} kind=${event.invocationKind ?? "?"}`);
      return undefined;
    }
    const roleKey = normalizeRoleKey(event.modelRole);
    if (roleKey.length === 0) return undefined;

    const pool = activeConfig.pools[roleKey];
    if (pool === undefined || pool.length === 0) return undefined; // Unconfigured role: core behavior unchanged.

    const availability = filterAvailable(pool, ctx.models);
    if (availability.count === 0) {
      // Hard-block only when the registry actually answered "none of these are
      // authenticated"; an unreadable registry is a transient failure, not a
      // reason to refuse the spawn.
      if (isStrictForRole(roleKey) && availability.registryReadable) {
        return { block: true, reason: `model-pool: no authenticated model available for role @${roleKey}` };
      }
      safeLog(pi, "warn", `[model-pool] empty pool for role=${roleKey} agent=${event.agent} kind=${event.invocationKind} registryReadable=${availability.registryReadable}; leaving spawn unmodified`);
      return undefined;
    }

    if (activeConfig.persistCounters) {
      return pickForRole(pi, roleKey, pool, availability).then((pick) => {
        if (pick === undefined) return undefined;
        const note = describePick(roleKey, pick.picked, pick.index, pool.length);
        safeLog(pi, "info", `[model-pool] role=${roleKey} agent=${event.agent} kind=${event.invocationKind} picked=${pick.picked} index=${pick.index} total=${pool.length} persisted=${pick.persisted}`);
        return { model: pick.picked, note };
      });
    }
    const pick = pickRoundRobin(roleKey, pool, availability.eligible);
    if (pick === undefined) return undefined;
    const note = describePick(roleKey, pick.picked, pick.index, pool.length);
    safeLog(pi, "info", `[model-pool] role=${roleKey} agent=${event.agent} kind=${event.invocationKind} picked=${pick.picked} index=${pick.index} total=${pool.length}`);
    return { model: pick.picked, note };
  } catch (err) {
    // Fail open: a router error must never break the task call.
    try {
      safeLog(pi, "warn", `[model-pool] handler error; failing open: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // ignore
    }
    return undefined;
  }
}

/** `session_start` handler: rotate the main session's model, main agent only. */
async function handleSessionStart(
  pi: ExtensionApiLike,
  _event: SessionStartEvent,
  ctx: ExtensionContextLike,
): Promise<void> {
  try {
    if (!activeConfig.enableMainSessionRotation) return;
    if (ctx.agent?.kind !== "main") return; // Main sessions only.

    // `session_start` also fires for a *loaded* session, so a resume must never
    // re-rotate: OMP restores that session's saved model, and overriding it here
    // would change the model mid-conversation and invalidate prompt caches.
    const freshness = sessionFreshness(ctx);
    if (freshness !== true) {
      safeLog(pi, "info", `[model-pool] main session not rotated (${freshness === false ? "loaded session already has a conversation" : "session novelty unknown"})`);
      return;
    }

    const roleKey = activeConfig.mainSessionRole;
    const pool = activeConfig.pools[roleKey];
    if (pool === undefined || pool.length === 0) return;

    const availability = filterAvailable(pool, ctx.models);
    if (availability.count === 0) {
      safeLog(pi, "warn", `[model-pool] main session: empty pool for role=${roleKey} registryReadable=${availability.registryReadable}; leaving model unchanged`);
      return;
    }
    const pick = await pickForRole(pi, roleKey, pool, availability);
    if (pick === undefined) return;
    const note = describePick(roleKey, pick.picked, pick.index, pool.length);
    safeLog(pi, "info", `[model-pool] main session role=${roleKey} picked=${pick.picked} index=${pick.index} total=${pool.length} persisted=${pick.persisted}`);
    if (typeof pi.setModel === "function") {
      await pi.setModel(pick.picked);
    }
    try {
      ctx.ui?.notify?.(`model-pool: ${note}`, "info");
    } catch {
      // Notification is best-effort.
    }
  } catch (err) {
    try {
      safeLog(pi, "warn", `[model-pool] session_start error; leaving model unchanged: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Extension factory (default export; OMP calls it with the ExtensionAPI).
// ---------------------------------------------------------------------------

/** Extension factory: load configuration and register both event handlers. */
export default function modelPoolExtension(pi: ExtensionApiLike, options?: ModelPoolConfig): void {
  if (options !== undefined) {
    configurePools(options);
  } else {
    configurePools(loadConfigFromEnv());
  }

  const roles = Object.keys(activeConfig.pools);
  safeLog(
    pi,
    "info",
    `[model-pool] loaded roles=[${roles.join(", ")}] mainRole=${activeConfig.mainSessionRole} mainRotation=${activeConfig.enableMainSessionRotation ? "on" : "off"} strict=${Array.isArray(activeConfig.strict) ? activeConfig.strict.join(",") : String(activeConfig.strict)} persist=${activeConfig.persistCounters ? activeConfig.stateFile : "off"}`,
  );

  pi.on("before_subagent_spawn", (event, ctx) =>
    handleBeforeSubagentSpawn(pi, event as BeforeSubagentSpawnEvent, ctx as ExtensionContextLike),
  );
  pi.on("session_start", (event, ctx) =>
    handleSessionStart(pi, event as SessionStartEvent, ctx as ExtensionContextLike),
  );
}
