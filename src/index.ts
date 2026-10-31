// omp-model-pool — round-robin model pools, exposed as models you pick.
//
// Each configured pool registers as a model named `pool/<name>`. It appears in
// OMP's model picker and role settings like any other model, and choosing it
// is the only way a pool takes effect: a role set to a real model is never
// rerouted. Pools never switch a running conversation's model, so prompt caches
// survive.
//
// Three paths resolve a `pool/<name>` selection to a real model:
//   * `before_subagent_spawn`: a child whose patterns name `pool/<name>` starts
//     on the next model in rotation; the pool's other eligible members follow
//     as that child's retry fallbacks.
//   * `session_start`: a fresh main session whose model is `pool/<name>`
//     switches to the next model in rotation before its first turn.
//   * the `pool` provider's `streamSimple`: anything else that calls
//     `pool/<name>` directly (commit messages, memory, a resumed session) is
//     forwarded to one member, pinned per session id.
//
// The configuration source is re-checked on every spawn and session start, so
// an edit to the pool file applies to the next pick without a restart.
//
// Counters are module-level, keyed by pool name, and shared by every session
// bound in this process; `persistCounters` shares them across processes.
//
// Model validation reuses core resolution: every pool entry goes through
// `ctx.models.resolve(spec)` and must also appear in `ctx.models.list()`.
// Unresolvable / unauthenticated entries are skipped without re-phasing the
// rotation.

import { createHash, randomUUID } from "node:crypto";
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

/** One selectable row for `ui.select`; `ui.select` returns the chosen `label`. */
interface UISelectItem {
  label: string;
  description?: string;
}

/**
 * Interactive UI surface used by the `/model-pool` command. Every member is
 * optional: a host in print/RPC mode exposes a no-op or partial UI, and the
 * command must detect that rather than assume dialogs are available.
 */
interface ExtensionUIContextLike {
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  select?: (
    title: string,
    options: (string | UISelectItem)[],
    dialogOptions?: unknown,
  ) => Promise<string | undefined>;
  input?: (title: string, placeholder?: string, dialogOptions?: unknown) => Promise<string | undefined>;
  confirm?: (title: string, message: string, dialogOptions?: unknown) => Promise<boolean>;
}

/** Options accepted by `pi.registerCommand`. */
interface ExtensionCommandOptions {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: ExtensionContextLike) => void | Promise<void>;
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
  ui?: ExtensionUIContextLike;
  /** False when the host has no interactive UI (print/RPC mode). */
  hasUI?: boolean;
  /** True while the agent is idle (not streaming). */
  isIdle?: () => boolean;
  /**
   * Read-only session manager. `getHeader()` reports the session's creation
   * timestamp, which distinguishes a session this process created from one it
   * loaded; `getEntries()` is the content fallback.
   */
  sessionManager?: { getEntries?: () => unknown; getHeader?: () => unknown };
  /** Credential lookup for a resolved model; used to forward direct `pool/<name>` requests. */
  modelRegistry?: { getApiKey?: (model: ModelLike, sessionId?: string) => Promise<string | undefined> };
  cwd?: string;
  [key: string]: unknown;
}

/** One model row in a provider registration (same fields as a `models.yml` entry). */
interface ProviderModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** Stream options the host passes to a provider's `streamSimple`. */
interface StreamOptionsLike {
  sessionId?: string;
  apiKey?: string;
  [key: string]: unknown;
}

/** The host's canonical assistant event stream: async-iterable, fed by `push`/`end`/`fail`. */
interface EventStreamLike extends AsyncIterable<unknown> {
  push(event: unknown): void;
  end(result?: unknown): void;
  fail(err: unknown): void;
}

interface ProviderConfigLike {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  streamSimple?: (model: ModelLike, context: unknown, options?: StreamOptionsLike) => EventStreamLike;
  models?: ProviderModelDefinition[];
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
  /**
   * Register a user-initiated slash command. Optional: a host that predates the
   * command surface, or that refuses registration, must not disable rotation.
   */
  registerCommand?(name: string, options: ExtensionCommandOptions): void;
  /**
   * Apply a model to the live session.
   *
   * The host takes a resolved `Model`, not a selector string — passing the
   * string silently does nothing on the real host. Resolves `false` when it
   * cannot apply the model (no credential for it), so the result must be read
   * rather than assumed.
   */
  setModel?(model: ModelLike): void | Promise<unknown>;
  /**
   * Register (or replace) a provider and its models in the host registry.
   * Optional: without it pools cannot appear as models, so nothing routes.
   */
  registerProvider?(name: string, config: ProviderConfigLike): void;
  /** Remove a provider this extension registered. */
  unregisterProvider?(name: string): void;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  [key: string]: unknown;
}

export interface ModelPoolConfig {
  /**
   * Pools keyed by name. Each one registers as the model `pool/<name>`; values
   * are real model selectors in cycle order. A pool applies only where that
   * model is selected (a role, `--model`, `/model`, an agent's `model:`).
   */
  pools: Record<string, string[]>;
  /**
   * Empty-pool policy. `false` (default) leaves the spawn on `pool/<name>`,
   * which the provider then forwards; `true` blocks every empty-pool spawn; an
   * array blocks only the listed pools.
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

/** Where the active pool configuration came from. */
export type ConfigSourceKind = "options" | "inline-env" | "file-env" | "default-file" | "none";

/**
 * Provenance of the active configuration, used by `status`/`doctor` and by the
 * editor to decide whether an accepted edit can be persisted.
 */
export interface ConfigSourceInfo {
  kind: ConfigSourceKind;
  /** Resolved file path when a saved edit can be written; absent for runtime-only sources. */
  path?: string;
  /** True when accepted pool edits can be persisted to disk. */
  writable: boolean;
  /** Short, non-sensitive description safe to show in the UI. */
  label: string;
  /** Why edits are runtime-only or disabled, when applicable. */
  note?: string;
}

/** Outcome of an attempted pool edit. */
export type PoolEditOutcome = { ok: true; runtimeOnly: boolean } | { ok: false; error: string };

/** Per-entry diagnosis used by `doctor`; never written anywhere. */
export interface PoolEntryDiagnosis {
  selector: string;
  eligible: boolean;
  reason: string;
}

/** Per-pool diagnosis used by `doctor`. */
export interface PoolDiagnosis {
  pool: string;
  entries: PoolEntryDiagnosis[];
}

// ---------------------------------------------------------------------------
// Module-level shared state (in-process round-robin counters).
// ---------------------------------------------------------------------------

const counters: Record<string, number> = Object.create(null);

/** State file name under the OMP agent dir when no explicit/env path is given. */
const DEFAULT_STATE_FILE = "model-pool-state.json";
/** Pool config file name under the OMP agent dir when no explicit/env path is given. */
const DEFAULT_CONFIG_FILE = "model-pool.json";
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
  strict: false,
  persistCounters: false,
  stateFile: resolveStateFilePath(),
};

/** Provider name every pool registers under: the pool `task` is the model `pool/task`. */
export const POOL_PROVIDER = "pool";
/** Extension-owned API id for the forwarding transport. */
const POOL_API = "model-pool";
/** Model metadata used until the real members are known; conservative so compaction never runs late. */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;
/** Pool names must be valid model ids: they become `pool/<name>`. */
const POOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Thinking suffixes OMP accepts on a chat selector (`pool/task:high`). */
const THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
  inherit: true,
};
/** Option keys removed in favour of selecting `pool/<name>`; reported once, never treated as pools. */
const RETIRED_KEYS = ["mainSessionRole", "enableMainSessionRotation"] as const;

/** Where the active configuration came from; drives the editor's save behaviour. */
let configSource: ConfigSourceInfo = {
  kind: "none",
  writable: true,
  label: "no configuration",
};

/** Bumped on every accepted configuration change; used to reject stale edits. */
let configRevision = 0;

/**
 * Signature of the last environment/default source applied by the factory.
 * Re-binding the extension to a child session re-runs the factory with no
 * options; when the backing source is unchanged we must keep any runtime edits
 * rather than resetting to the on-disk document.
 */
let loadedSignature: string | undefined;

/** Shape of the backing document, so edits write back in the same form. */
let configShape: "nested" | "flat" | "none" = "none";

/** Content fingerprint of the backing file, re-checked under the edit lock. */
let configFingerprint: string | undefined;

/** Apply a normalized configuration to the active slots. */
function applyNormalized(normalized: ReturnType<typeof normalizeConfig>): void {
  activeConfig.pools = normalized.pools;
  activeConfig.strict = normalized.strict;
  activeConfig.persistCounters = normalized.persistCounters;
  activeConfig.stateFile = normalized.stateFile;
}

/**
 * Replace the active pool configuration (used by the factory and tests). This
 * is an intentional, unconditional replacement: a caller passing options means
 * "use these", so it supersedes any runtime edit.
 */
export function configurePools(next: ModelPoolConfig | undefined | null): void {
  applyNormalized(normalizeConfig(next));
  // An explicit replacement is runtime-only and points at no file: reset the
  // provenance so a later edit cannot merge these programmatic pools into the
  // previously loaded document. Mirrors the factory's options path.
  configSource = {
    kind: "options",
    writable: false,
    label: "programmatic options",
    note: "runtime-only: options cannot be rewritten",
  };
  configShape = "none";
  configFingerprint = undefined;
  // An explicit replacement invalidates the source signature, so a later
  // no-options or same-options re-bind re-applies instead of assuming the
  // active configuration still matches the last loaded source.
  loadedSignature = undefined;
  configRevision += 1;
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

/** Read-only snapshot of where the active configuration came from. */
export function getConfigSource(): ConfigSourceInfo {
  return { ...configSource };
}

/** Monotonic revision of the active configuration; used to reject stale edits. */
export function getConfigRevision(): number {
  return configRevision;
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
 * Resolve the profile-scoped default pool config: `<agent dir>/model-pool.json`.
 *
 * Unlike `OMP_MODEL_POOL_CONFIG` (an explicit path resolved against the process
 * CWD, kept as-is for backwards compatibility), the default file follows OMP's
 * own agent-dir resolution so each profile keeps its own pools.
 */
export function resolveDefaultConfigFilePath(): string {
  return path.join(agentDir(), DEFAULT_CONFIG_FILE);
}

/** Compare two paths for identity, case-insensitively on Windows. */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Short content fingerprint; not a security hash, only a change detector. */
function fingerprintText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** File mode to preserve when rewriting an existing file; 0600 for a new one. */
function existingMode(file: string): number {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/** Write `contents` via an exclusive temp file and an atomic rename. */
function writeFileAtomicSync(file: string, contents: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Temp cleanup is best-effort.
    }
  }
}

/** Read and parse a JSON object file, distinguishing "missing" from "unreadable". */
type JsonFileRead =
  | { ok: true; value: unknown; fingerprint: string }
  | { ok: false; missing: boolean; reason: string };

function readJsonFileWithReason(file: string): JsonFileRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, missing: code === "ENOENT", reason: err instanceof Error ? err.message : String(err) };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (err) {
    return { ok: false, missing: false, reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, missing: false, reason: "not a JSON object" };
  }
  // A nested document must hold an object under `pools`. Accepting an array,
  // string, number or null there would let a later edit overwrite it, silently
  // destroying a document we do not actually understand.
  const doc = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(doc, "pools")) {
    const pools = doc["pools"];
    if (pools === null || typeof pools !== "object" || Array.isArray(pools)) {
      return { ok: false, missing: false, reason: 'the "pools" key must be a JSON object' };
    }
  }
  return { ok: true, value, fingerprint: fingerprintText(raw) };
}

/** Which accepted document shape a file/inline source uses. */
function detectShape(doc: unknown): "nested" | "flat" | "none" {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "none";
  return Object.prototype.hasOwnProperty.call(doc, "pools") ? "nested" : "flat";
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
  writeFileAtomicSync(file, `${JSON.stringify({ version: SCHEMA_VERSION, counters: next }, null, 2)}\n`);
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

/**
 * Run `fn` while holding an atomic-directory lock on `<file>.lock`; abandoned
 * locks are reclaimed. Shared by the counter state file and the pool config
 * file, so two writers on the same path never interleave.
 */
async function withFileLock<T>(file: string, fn: () => T): Promise<T> {
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
  poolName: string,
  poolLength: number,
  eligible: boolean[],
  file: string,
): Promise<{ index: number; replacedLegacy: boolean } | undefined> {
  return withFileLock(file, () => {
    const read = readPersistedCounters(file);
    if (read.legacy) quarantineLegacyState(file);
    const persisted = read.counters;
    const start = poolLength === 0 ? 0 : (persisted[poolName] ?? 0) % poolLength;
    for (let offset = 0; offset < poolLength; offset++) {
      const index = (start + offset) % poolLength;
      if (eligible[index] !== true) continue;
      persisted[poolName] = (index + 1) % poolLength;
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
export function normalizePoolName(raw: unknown): string {
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

/** The internal form every accepted config shape normalizes to. */
interface NormalizedConfig {
  pools: Record<string, string[]>;
  strict: boolean | string[];
  persistCounters: boolean;
  stateFile: string;
  /** Problems found while normalizing (skipped names or entries, retired keys); logged, never fatal. */
  warnings: string[];
}

/** Normalize any accepted config shape (nested `pools` or flat map) into the internal form. */
function normalizeConfig(raw: ModelPoolConfig | undefined | null): NormalizedConfig {
  const warnings: string[] = [];
  const legacy = raw as Record<string, unknown> | undefined | null;
  for (const key of RETIRED_KEYS) {
    if (legacy !== null && legacy !== undefined && Object.prototype.hasOwnProperty.call(legacy, key)) {
      warnings.push(
        `"${key}" is no longer used and is ignored: a pool applies wherever you select its model, e.g. set the default role to pool/<name>`,
      );
    }
  }
  const pools: Record<string, string[]> = Object.create(null);
  const rawPools: unknown = raw?.pools ?? raw;
  if (rawPools !== null && typeof rawPools === "object" && !Array.isArray(rawPools)) {
    for (const [k, v] of Object.entries(rawPools as Record<string, unknown>)) {
      const key = normalizePoolName(k);
      if (key.length === 0) continue;
      // Compare the name a pool would actually get, so `"@strict"` and
      // `" strict "` cannot alias past the guard and shadow a real option.
      if (raw?.pools === undefined && RESERVED_FLAT_KEYS.has(key)) continue;
      if (!POOL_NAME_PATTERN.test(key)) {
        warnings.push(`pool "${k}" skipped: a pool name becomes the model id pool/<name>, so use letters, digits, ".", "_" or "-"`);
        continue;
      }
      const list: string[] = [];
      for (const selector of normalizeStringList(v)) {
        if (selector.startsWith(`${POOL_PROVIDER}/`)) {
          warnings.push(`pool "${key}": entry ${selector} skipped; a pool cannot contain another pool`);
          continue;
        }
        list.push(selector);
      }
      if (list.length > 0) pools[key] = list;
    }
  }
  return {
    pools,
    strict: raw?.strict ?? false,
    // Opt-in must be exactly boolean true: a stray `"false"` string would be
    // truthy and would silently start writing a shared state file.
    persistCounters: raw?.persistCounters === true,
    stateFile: resolveStateFilePath(raw?.stateFile),
    warnings,
  };
}

/** A `pool/<name>` selector, split into the pool name and an optional thinking suffix. */
interface PoolSelector {
  name: string;
  /** `:high` style suffix, including the colon; `""` when absent. */
  thinking: string;
}

/**
 * Parse `pool/<name>` or `pool/<name>:<level>`. Returns undefined for anything
 * else, including a suffix that is not a thinking level (pool names cannot
 * contain `:`, so that cannot be a pool).
 */
export function parsePoolSelector(selector: unknown): PoolSelector | undefined {
  if (typeof selector !== "string") return undefined;
  const prefix = `${POOL_PROVIDER}/`;
  const trimmed = selector.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  const rest = trimmed.slice(prefix.length);
  const colon = rest.indexOf(":");
  const name = colon === -1 ? rest : rest.slice(0, colon);
  const level = colon === -1 ? "" : rest.slice(colon + 1);
  if (!POOL_NAME_PATTERN.test(name)) return undefined;
  if (colon !== -1 && THINKING_LEVELS[level] !== true) return undefined;
  return { name, thinking: colon === -1 ? "" : `:${level}` };
}

/**
 * Load the effective configuration and its provenance.
 *
 * Precedence: programmatic `options` (handled by the factory) > inline
 * `OMP_MODEL_POOLS_JSON` > explicit `OMP_MODEL_POOL_CONFIG` file > the
 * profile-scoped default file > empty. Routing stays fail-open: a malformed
 * higher-priority source falls through with a warning, while the same source
 * disables editing so an accepted edit can never land in a surprising file.
 */
interface LoadedConfig {
  config: ModelPoolConfig;
  source: ConfigSourceInfo;
  shape: "nested" | "flat" | "none";
  fingerprint?: string;
  warnings: string[];
}

function loadConfigWithSource(): LoadedConfig {
  const warnings: string[] = [];
  const emptyConfig = (): ModelPoolConfig => ({ pools: Object.create(null) });
  /**
   * Set when a higher-priority source was present but unusable. Routing still
   * falls through (fail open), but editing must be disabled: otherwise an
   * accepted edit would be written to a lower-priority file the operator did
   * not intend to be authoritative.
   */
  let blockedReason: string | undefined;
  const blocked = (source: ConfigSourceInfo): ConfigSourceInfo =>
    blockedReason === undefined
      ? source
      : { ...source, writable: false, note: `editing disabled: ${blockedReason}` };

  const inline = process.env["OMP_MODEL_POOLS_JSON"];
  if (typeof inline === "string" && inline.trim().length > 0) {
    try {
      const parsed = JSON.parse(inline) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Pass through unchanged: a flat map keeps its option keys
        // (persistCounters, stateFile, …) at the top level, where
        // normalizeConfig reads them. Wrapping it as `pools` would hide them.
        return {
          config: parsed as ModelPoolConfig,
          source: {
            kind: "inline-env",
            writable: false,
            label: "OMP_MODEL_POOLS_JSON",
            note: "runtime-only: inline JSON cannot be rewritten",
          },
          shape: detectShape(parsed),
          fingerprint: fingerprintText(inline),
          warnings,
        };
      }
      warnings.push("OMP_MODEL_POOLS_JSON is not a JSON object; ignoring it");
      blockedReason = "OMP_MODEL_POOLS_JSON is set but is not a JSON object";
    } catch (err) {
      warnings.push(
        `OMP_MODEL_POOLS_JSON is not valid JSON (${err instanceof Error ? err.message : String(err)}); ignoring it`,
      );
      blockedReason = "OMP_MODEL_POOLS_JSON is set but is not valid JSON";
    }
  }

  const explicit = process.env["OMP_MODEL_POOL_CONFIG"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    const resolved = path.resolve(explicit.trim());
    const read = readJsonFileWithReason(resolved);
    if (read.ok) {
      return {
        config: read.value as ModelPoolConfig,
        source: blocked({ kind: "file-env", path: resolved, writable: true, label: resolved }),
        shape: detectShape(read.value),
        fingerprint: read.fingerprint,
        warnings,
      };
    }
    if (read.missing) {
      warnings.push(
        `OMP_MODEL_POOL_CONFIG points at a missing file (${resolved}); it will be created on the first saved edit`,
      );
      return {
        config: emptyConfig(),
        source: blocked({
          kind: "file-env",
          path: resolved,
          writable: true,
          label: resolved,
          note: "missing file will be created on the first saved edit",
        }),
        shape: "nested",
        warnings,
      };
    }
    // Routing falls through to the next source (the profile default file, then
    // empty), but editing is disabled: writing an edit while a shadowing
    // higher-priority source is broken would divert it somewhere the operator
    // did not intend it to be authoritative.
    warnings.push(
      `OMP_MODEL_POOL_CONFIG could not be read (${resolved}): ${read.reason}; routing falls through and pool editing is disabled until it is repaired`,
    );
    blockedReason = `OMP_MODEL_POOL_CONFIG (${resolved}) could not be read: ${read.reason}`;
  }

  const fallback = resolveDefaultConfigFilePath();
  const read = readJsonFileWithReason(fallback);
  if (read.ok) {
    return {
      config: read.value as ModelPoolConfig,
      source: blocked({ kind: "default-file", path: fallback, writable: true, label: fallback }),
      shape: detectShape(read.value),
      fingerprint: read.fingerprint,
      warnings,
    };
  }
  if (read.missing) {
    return {
      config: emptyConfig(),
      source: blocked({
        kind: "none",
        path: fallback,
        writable: true,
        label: `no configuration (will create ${fallback})`,
      }),
      shape: "none",
      warnings,
    };
  }
  warnings.push(
    `default config ${fallback} could not be read: ${read.reason}; pool editing is disabled until it is repaired`,
  );
  return {
    config: emptyConfig(),
    source: {
      kind: "default-file",
      path: fallback,
      writable: false,
      label: fallback,
      note: `unreadable: ${read.reason}`,
    },
    shape: "none",
    warnings,
  };
}

/**
 * Stable signature of a normalized options document.
 *
 * Programmatic options are also re-applied on every factory re-bind, so they
 * need the same "unchanged source" comparison the environment source has;
 * without it a child-session re-bind would silently discard runtime-only edits.
 */
function optionsSignature(normalized: NormalizedConfig): string {
  const pools = Object.keys(normalized.pools)
    .sort()
    .map((name) => `${name}=${(normalized.pools[name] ?? []).join(",")}`)
    .join(";");
  const strict = Array.isArray(normalized.strict) ? normalized.strict.join(",") : String(normalized.strict);
  return `${pools}|${strict}|${normalized.persistCounters}|${normalized.stateFile}`;
}

/** Signature that decides whether a re-bind or refresh must reload the environment source. */
function sourceSignature(source: ConfigSourceInfo, fingerprint: string | undefined): string {
  return `${source.kind}:${source.path ?? ""}:${source.writable ? "w" : "r"}:${fingerprint ?? ""}`;
}

/**
 * Apply a loaded source to the active configuration and record its provenance.
 * Returns every warning from loading and normalizing, for the caller to log.
 */
function configureLoaded(loaded: LoadedConfig): string[] {
  const normalized = normalizeConfig(loaded.config);
  applyNormalized(normalized);
  configSource = loaded.source;
  configShape = loaded.shape;
  configFingerprint = loaded.fingerprint;
  configRevision += 1;
  return [...loaded.warnings, ...normalized.warnings];
}

/**
 * Re-read the environment/default source and apply it when it changed.
 *
 * Runs at load and again before every pick, so an edit to the pool file takes
 * effect on the next spawn instead of one spawn late. An unchanged source keeps
 * runtime-only edits. Programmatic options have no source to re-read.
 */
function refreshFromSource(pi: ExtensionApiLike): void {
  if (configSource.kind === "options") return;
  const loaded = loadConfigWithSource();
  const signature = sourceSignature(loaded.source, loaded.fingerprint);
  if (signature === loadedSignature) return;
  const warnings = configureLoaded(loaded);
  loadedSignature = signature;
  prunePinsForConfiguredPools();
  for (const warning of warnings) safeLog(pi, "warn", `[model-pool] ${warning}`);
}

/**
 * Drop pins whose pool no longer exists. A pin is only meaningful while its
 * pool does, so removing the pool's members must not leave a stale entry that a
 * later pool of the same name could inherit.
 */
function prunePinsForConfiguredPools(): void {
  for (const key of sessionPins.keys()) {
    const separator = key.lastIndexOf("\u0000");
    if (separator === -1 || activeConfig.pools[key.slice(separator + 1)] === undefined) sessionPins.delete(key);
  }
}

// ---------------------------------------------------------------------------
// The `pool` provider: one model per pool, so pools are chosen in OMP's own
// model picker and role settings.
// ---------------------------------------------------------------------------

/** The two pieces of `@oh-my-pi/pi-ai` the forwarder needs. */
interface PiAiModule {
  AssistantMessageEventStream: new () => EventStreamLike;
  streamSimple: (model: ModelLike, context: unknown, options?: StreamOptionsLike) => AsyncIterable<unknown>;
}

let piAi: PiAiModule | undefined;
let piAiLoad: Promise<void> | undefined;

/**
 * Start loading the host's stream module once; forwarding needs it, routing
 * does not. The specifier must stay a string literal: OMP finds the host
 * packages an extension imports by parsing its source, and rewrites only the
 * specifiers it can see. The package is not a dependency (types live in
 * `host-modules.d.ts`), so under plain Node the import fails and is logged.
 */
function loadPiAi(pi: ExtensionApiLike): void {
  if (piAiLoad !== undefined) return;
  piAiLoad = import("@oh-my-pi/pi-ai").then(
    (mod: unknown) => {
      const candidate = mod as Partial<PiAiModule> | null;
      if (typeof candidate?.AssistantMessageEventStream === "function" && typeof candidate.streamSimple === "function") {
        piAi = candidate as PiAiModule;
      } else {
        safeLog(pi, "warn", "[model-pool] host stream module lacks streamSimple; direct pool/<name> requests cannot be forwarded");
      }
    },
    (err: unknown) => {
      safeLog(pi, "warn", `[model-pool] host stream module unavailable; direct pool/<name> requests cannot be forwarded: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
}

/** Latest host API, model query and credential lookup, captured from a live context for the forwarder. */
let hostApi: ExtensionApiLike | undefined;
let hostModels: ModelsQuery | undefined;
let hostRegistry: ExtensionContextLike["modelRegistry"];

function captureHost(pi: ExtensionApiLike, ctx: ExtensionContextLike): void {
  hostApi = pi;
  if (ctx.models !== undefined) hostModels = ctx.models;
  if (ctx.modelRegistry !== undefined) hostRegistry = ctx.modelRegistry;
}

/** Read a positive numeric model field, or undefined. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * One provider model per pool, described by its members: limits are the
 * smallest among the members that resolve, so a pool never advertises more
 * context than its weakest member can take; cost is the highest member price,
 * so a paid member is never reported as a free call; and images are offered
 * only when every member accepts them, since the host decides on the pool's
 * capabilities before the request reaches whichever member answers.
 *
 * Without a registry the defaults stay conservative: the fallback limits, zero
 * cost, and text-only input.
 */
function poolModelDefinitions(models: ModelsQuery | undefined): ProviderModelDefinition[] {
  const out: ProviderModelDefinition[] = [];
  for (const name of Object.keys(activeConfig.pools).sort()) {
    const members = activeConfig.pools[name] ?? [];
    let contextWindow: number | undefined;
    let maxTokens: number | undefined;
    let reasoning = false;
    let images = members.length > 0;
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const selector of members) {
      let resolved: ModelLike | undefined;
      try {
        resolved = models?.resolve(selector);
      } catch {
        resolved = undefined;
      }
      if (resolved === undefined || resolved === null) continue;
      const window = positiveNumber(resolved["contextWindow"]);
      const tokens = positiveNumber(resolved["maxTokens"]);
      if (window !== undefined) contextWindow = contextWindow === undefined ? window : Math.min(contextWindow, window);
      if (tokens !== undefined) maxTokens = maxTokens === undefined ? tokens : Math.min(maxTokens, tokens);
      if (resolved["reasoning"] === true) reasoning = true;
      const input = resolved["input"];
      if (!Array.isArray(input) || input.includes("image") !== true) images = false;
      const memberCost = resolved["cost"];
      if (memberCost !== null && typeof memberCost === "object") {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = positiveNumber((memberCost as Record<string, unknown>)[key]);
          if (value !== undefined) cost[key] = Math.max(cost[key], value);
        }
      }
    }
    out.push({
      id: name,
      name: `Pool: ${name} (${members.length} models)`,
      reasoning,
      input: images ? ["text", "image"] : ["text"],
      cost,
      contextWindow: contextWindow ?? FALLBACK_CONTEXT_WINDOW,
      maxTokens: maxTokens ?? FALLBACK_MAX_TOKENS,
    });
  }
  return out;
}

/** Last registration per host API object, so an unchanged pool set is not re-registered. */
const registeredSignatures = new WeakMap<ExtensionApiLike, string>();

/** Register `pool/<name>` for every configured pool, or remove the provider when none remain. */
function syncPoolProvider(pi: ExtensionApiLike, models: ModelsQuery | undefined): void {
  if (typeof pi.registerProvider !== "function") {
    if (!registeredSignatures.has(pi)) {
      safeLog(pi, "warn", "[model-pool] host cannot register providers; pools cannot appear as models and nothing will route");
      registeredSignatures.set(pi, "");
    }
    return;
  }
  const definitions = poolModelDefinitions(models);
  const signature = JSON.stringify(definitions);
  const previous = registeredSignatures.get(pi);
  if (previous === signature) return;
  try {
    if (definitions.length === 0) {
      // Re-registering with no models also clears the old ones on hosts that
      // cannot unregister: a deleted pool must not stay selectable and then
      // fail because nothing backs it.
      if (typeof pi.unregisterProvider === "function") pi.unregisterProvider(POOL_PROVIDER);
      else if (previous !== undefined) pi.registerProvider(POOL_PROVIDER, { models: [] });
    } else {
      pi.registerProvider(POOL_PROVIDER, {
        baseUrl: "https://model-pool.invalid/",
        apiKey: "model-pool-forwards-to-member-credentials",
        api: POOL_API,
        streamSimple: forwardPoolRequest,
        models: definitions,
      });
    }
    registeredSignatures.set(pi, signature);
  } catch (err) {
    safeLog(pi, "warn", `[model-pool] registering pool models failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Member chosen for a direct `pool/<name>` request, pinned per session so its cache survives. */
const sessionPins = new Map<string, string>();

/**
 * Choose the real model for a direct `pool/<name>` request. A session keeps its
 * first pick while that member stays eligible; a request without a session id
 * (a one-shot) takes the next model in rotation.
 */
async function forwardTarget(poolName: string, sessionId: string | undefined): Promise<{ selector: string; model: ModelLike }> {
  const pool = activeConfig.pools[poolName];
  if (pool === undefined || pool.length === 0) throw new Error(`model-pool: pool "${poolName}" is not configured`);
  const models = hostModels;
  const api = hostApi;
  const availability = filterAvailable(pool, models);
  if (availability.count === 0 || models === undefined || api === undefined) {
    throw new Error(`model-pool: no authenticated model available in pool "${poolName}"`);
  }
  const pinKey = sessionId === undefined ? undefined : `${sessionId}\u0000${poolName}`;
  const pinned = pinKey === undefined ? undefined : sessionPins.get(pinKey);
  let selector = pinned !== undefined && availability.eligible[pool.indexOf(pinned)] === true ? pinned : undefined;
  if (selector === undefined) {
    // Two first requests for one session can overlap before either stores a
    // pin; sharing one in-flight decision keeps them on the same member instead
    // of streaming on two models at once.
    selector = await pickOnceForPin(pinKey, async () => {
      const pick = await pickForPool(api, poolName, pool, availability);
      if (pick === undefined) throw new Error(`model-pool: no authenticated model available in pool "${poolName}"`);
      return pick.picked;
    });
    safeLog(api, "info", `[model-pool] forwarding pool/${poolName} → ${selector}${pinKey === undefined ? " (one-shot)" : " (pinned for this session)"}`);
  }

  const model = models.resolve(selector);
  if (model === undefined || model === null) throw new Error(`model-pool: ${selector} no longer resolves`);
  return { selector, model };
}

/** In-flight first picks, so concurrent first requests share one decision. */
const pinPicks = new Map<string, Promise<string>>();

/**
 * Choose a member for `pinKey` once. A request without a session id has no pin
 * to share, so it takes its own fresh rotation. A shared pick stores the pin
 * before any caller uses it.
 */
async function pickOnceForPin(pinKey: string | undefined, pick: () => Promise<string>): Promise<string> {
  if (pinKey === undefined) return pick();
  const existing = pinPicks.get(pinKey);
  if (existing !== undefined) return existing;
  const started = (async () => {
    const selector = await pick();
    sessionPins.set(pinKey, selector);
    return selector;
  })();
  pinPicks.set(pinKey, started);
  try {
    return await started;
  } finally {
    pinPicks.delete(pinKey);
  }
}

/**
 * The `pool` provider's transport: replay the request on one real member and
 * pass the member's stream through unchanged.
 *
 * The member's terminal result is what settles this stream's `result()`, so it
 * is handed to `end()`: a consumer that awaits a final message must get the
 * member's, not an empty one. Everything else — tool calls, thinking, usage —
 * arrives as ordinary events and is pushed as it comes.
 */
function forwardPoolRequest(model: ModelLike, context: unknown, options?: StreamOptionsLike): EventStreamLike {
  const lib = piAi;
  if (lib === undefined) {
    throw new Error("model-pool: the host stream module is not available, so pool/<name> cannot be called directly");
  }
  const out = new lib.AssistantMessageEventStream();
  void (async () => {
    try {
      const poolName = typeof model.id === "string" ? model.id : "";
      // A running session can outlive an edit to the pool file, so refresh
      // before picking: a removed member must not be reached again.
      refreshHost();
      const target = await forwardTarget(poolName, options?.sessionId);
      const apiKey = await hostRegistry?.getApiKey?.(target.model, options?.sessionId);
      if (apiKey === undefined || apiKey.length === 0) throw new Error(`model-pool: no credential for ${target.selector}`);
      let final: unknown;
      for await (const event of lib.streamSimple(target.model, context, { ...options, apiKey })) {
        out.push(event);
        if (isDoneEvent(event)) final = event.message;
      }
      out.end(final);
    } catch (err) {
      out.fail(err);
    }
  })();
  return out;
}

/** The member stream's successful terminal event, which carries its final message. */
function isDoneEvent(event: unknown): event is { type: "done"; message: unknown } {
  if (event === null || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  return record.type === "done" && record.message !== null && typeof record.message === "object";
}

/** Re-read the config file and re-register pool models from the last captured host. */
function refreshHost(): void {
  if (hostApi === undefined) return;
  refreshFromSource(hostApi);
  syncPoolProvider(hostApi, hostModels);
}

// ---------------------------------------------------------------------------
// Pool editing (auto-saved when a file is the authoritative source).
//
// Each accepted edit is its own transaction. A file-backed edit is written and
// committed before the in-memory pools change, so a save failure leaves both
// the file and the active pools exactly as they were. A runtime-only source
// (programmatic options, inline JSON, or a disabled editor) changes memory only.
// ---------------------------------------------------------------------------

/** Top-level keys that a flat-config pool name would collide with (retired keys included). */
const RESERVED_FLAT_KEYS = new Set([
  "pools",
  "mainSessionRole",
  "enableMainSessionRotation",
  "strict",
  "persistCounters",
  "stateFile",
]);

/**
 * Replace or delete one pool in memory without touching counters. Pins for the
 * pool are dropped: a pin describes a member of the pool as it was, and a
 * re-created pool must pick afresh rather than resume an older edition's member.
 */
function applyPoolChange(name: string, selectors: string[] | null): void {
  const pools: Record<string, string[]> = Object.create(null);
  for (const [k, v] of Object.entries(activeConfig.pools)) pools[k] = [...v];
  if (selectors === null) delete pools[name];
  else pools[name] = [...selectors];
  activeConfig.pools = pools;
  forgetPins(name);
}

/** Drop every session's pin for one pool. */
function forgetPins(poolName: string): void {
  const suffix = `\u0000${poolName}`;
  for (const key of sessionPins.keys()) {
    if (key.endsWith(suffix)) sessionPins.delete(key);
  }
}

/**
 * Own-property copy onto a null-prototype object, so a role literally named
 * `__proto__` is stored as data instead of mutating a prototype.
 */
function copyOwnProperties(source: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  if (source !== null && typeof source === "object" && !Array.isArray(source)) {
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) out[k] = v;
  }
  return out;
}

/** Drop keys that normalize to `name` but are written differently (`"@slow"`, padded). */
function dropAliasKeys(target: Record<string, unknown>, name: string): void {
  for (const key of Object.keys(target)) {
    if (key !== name && normalizePoolName(key) === name) delete target[key];
  }
}

/** Build the document to write, preserving unrelated keys and the source shape. */
function buildDocument(
  name: string,
  selectors: string[] | null,
  shape: "nested" | "flat" | "none",
  rawDoc: unknown,
): Record<string, unknown> {
  const base = copyOwnProperties(rawDoc);
  if (shape === "flat") {
    dropAliasKeys(base, name);
    if (selectors === null) delete base[name];
    else base[name] = selectors;
    return base;
  }
  const pools = copyOwnProperties(base["pools"]);
  // Match the pool as the active config knows it, so deleting `@slow` removes the
  // document's `"@slow"` key rather than leaving it to reappear on the next load.
  dropAliasKeys(pools, name);
  if (selectors === null) delete pools[name];
  else pools[name] = selectors;
  // Keep the `pools` key even when it is empty. Dropping it would make the next
  // `detectShape()` read the document as flat, so a later pool addition would be
  // written at the top level and silently change the file's established shape.
  base["pools"] = pools;
  return base;
}

/** How an accepted pool edit is applied for the active source. */
type EditMode = "file" | "runtime-only" | "disabled";

/**
 * Classify the active source for editing.
 *
 * `runtime-only` sources (programmatic options, inline JSON) accept edits into
 * memory. A `disabled` source is an authoritative file that could not be read,
 * or one shadowed by a malformed higher-priority source: edits must be refused
 * there rather than silently diverted into memory or into another file.
 */
function editMode(): EditMode {
  if (configSource.kind === "options" || configSource.kind === "inline-env") return "runtime-only";
  if (!configSource.writable || configSource.path === undefined) return "disabled";
  return "file";
}

/**
 * Save one pool, or delete it with `selectors === null`.
 *
 * `expectedRevision` guards against a stale editor: when the configuration
 * changed since the editor captured it, the edit is rejected instead of
 * overwriting a newer change. File-backed saves re-read and fingerprint-check
 * the file under an atomic-directory lock before writing, so a cooperating
 * writer is never silently overwritten.
 */
export async function savePoolEdit(
  pool: string,
  selectors: string[] | null,
  expectedRevision?: number,
): Promise<PoolEditOutcome> {
  const name = normalizePoolName(pool);
  if (name.length === 0) return { ok: false, error: "a pool name is required" };
  if (!POOL_NAME_PATTERN.test(name)) {
    return { ok: false, error: `"${name}" cannot be a pool name: it becomes pool/<name>, so use letters, digits, ".", "_" or "-"` };
  }
  if (expectedRevision !== undefined && expectedRevision !== configRevision) {
    return { ok: false, error: "the configuration changed since this edit started; reopen the editor" };
  }
  const next = selectors === null ? null : normalizeStringList(selectors);
  if (next !== null && next.length === 0) {
    return { ok: false, error: "refusing to save an empty pool; delete the pool instead" };
  }
  const nested = next?.find((selector) => selector.startsWith(`${POOL_PROVIDER}/`));
  if (nested !== undefined) return { ok: false, error: `a pool cannot contain another pool (${nested})` };
  if (configShape === "flat" && RESERVED_FLAT_KEYS.has(name)) {
    return {
      ok: false,
      error: `a flat config cannot hold a pool named "${name}" (it collides with a top-level option key)`,
    };
  }

  const mode = editMode();
  if (mode === "disabled") {
    return {
      ok: false,
      error: `pool editing is disabled: ${configSource.note ?? "the configuration source is not writable"}`,
    };
  }
  if (mode === "runtime-only") {
    applyPoolChange(name, next);
    configRevision += 1;
    return { ok: true, runtimeOnly: true };
  }
  const file = configSource.path;
  if (file === undefined) {
    return { ok: false, error: "pool editing is disabled: the configuration source has no writable path" };
  }

  if (
    samePath(file, activeConfig.stateFile) ||
    samePath(file, `${activeConfig.stateFile}.lock`) ||
    // The reverse alias: a state file set to `<config>.lock` would make this
    // save treat the state path as its lock directory.
    samePath(activeConfig.stateFile, `${file}.lock`)
  ) {
    return { ok: false, error: `refusing to write pool config over the counter state file (${file})` };
  }

  // A brand-new default file has no fingerprint yet; anything already on disk
  // must match the fingerprint captured when the source was loaded.
  const expectedFingerprint = configSource.kind === "none" ? undefined : configFingerprint;
  const revisionAtStart = configRevision;
  let fingerprintConflict = false;
  try {
    await withFileLock(file, () => {
      // Re-check under the lock: a concurrent edit (or `configurePools`) that
      // committed while this call waited must not be overwritten by a stale one.
      if (configRevision !== revisionAtStart) {
        throw new Error("the configuration changed while this edit waited for the file lock; reopen the editor");
      }
      const current = readJsonFileWithReason(file);
      if (!current.ok && !current.missing) throw new Error(current.reason);
      const currentFingerprint = current.ok ? current.fingerprint : undefined;
      if (currentFingerprint !== expectedFingerprint) {
        fingerprintConflict = true;
        throw new Error("the configuration file changed on disk since it was loaded; reopen the editor");
      }
      const doc = buildDocument(name, next, configShape, current.ok ? current.value : undefined);
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      writeFileAtomicSync(file, text, existingMode(file));
      configFingerprint = fingerprintText(text);
      if (configSource.kind === "none") {
        configSource = { kind: "default-file", path: file, writable: true, label: file };
      }
      // Commit the in-memory change inside the lock, so a second save that
      // passed the pre-lock revision check sees the bumped revision and refuses
      // instead of overwriting this write.
      applyPoolChange(name, next);
      configRevision += 1;
      // The file now holds exactly what memory holds; record that, so the next
      // refresh does not reload this same write and bump the revision under an
      // editor that is still open.
      loadedSignature = sourceSignature(configSource, configFingerprint);
    });
  } catch (err) {
    if (fingerprintConflict) {
      const loaded = loadConfigWithSource();
      configureLoaded(loaded);
      loadedSignature = sourceSignature(loaded.source, loaded.fingerprint);
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, runtimeOnly: false };
}

/**
 * Diagnose every configured pool entry against the live registry. Read-only:
 * it never writes, never advances a counter and never acquires a lock. It is
 * the same membership rule the router uses, so `doctor` cannot disagree with a
 * spawn about whether an entry is usable.
 */
export function diagnosePools(models: ModelsQuery | undefined): {
  registryReadable: boolean;
  registryNote: string;
  pools: PoolDiagnosis[];
} {
  let registryReadable = false;
  let registryNote = "model registry unavailable";
  if (models !== undefined) {
    try {
      const listed = models.list() ?? [];
      registryReadable = true;
      registryNote =
        listed.length === 0
          ? "registry readable, no authenticated models"
          : `registry readable, ${listed.length} authenticated model(s)`;
    } catch (err) {
      registryNote = `registry read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const pools: PoolDiagnosis[] = [];
  for (const [name, pool] of Object.entries(activeConfig.pools)) {
    const entries: PoolEntryDiagnosis[] = pool.map((selector) => {
      if (models === undefined) return { selector, eligible: false, reason: "registry unavailable" };
      let resolved: ModelLike | undefined;
      try {
        resolved = models.resolve(selector);
      } catch {
        resolved = undefined;
      }
      if (resolved === undefined || resolved === null) {
        return { selector, eligible: false, reason: "unresolved" };
      }
      const id = modelIdentity(resolved);
      if (id.length === 0) return { selector, eligible: false, reason: "resolved without an identity" };
      const availability = filterAvailable([selector], models);
      return availability.eligible[0] === true
        ? { selector, eligible: true, reason: `authenticated as ${id}` }
        : { selector, eligible: false, reason: `not authenticated (${id} is not in the registry list)` };
    });
    pools.push({ pool: name, entries });
  }
  return { registryReadable, registryNote, pools };
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

/** Does the configured `strict` policy cover this pool? */
function isStrictForPool(poolName: string): boolean {
  const { strict } = activeConfig;
  if (strict === true) return true;
  if (Array.isArray(strict)) return strict.map((entry) => normalizePoolName(entry)).includes(poolName);
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
    // Authentication is proven only by membership in the registry's own
    // authenticated list. A selector that resolves but is not listed is not
    // authenticated, and a readable-but-empty list authenticates nothing; an
    // unreadable registry is the separate, fail-open case handled above.
    if (id.length === 0 || !identities.has(id)) continue;
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
  poolName: string,
  pool: string[],
  eligible: boolean[],
): { picked: string; index: number } | undefined {
  const start = pool.length === 0 ? 0 : (counters[poolName] ?? 0) % pool.length;
  for (let offset = 0; offset < pool.length; offset++) {
    const index = (start + offset) % pool.length;
    if (eligible[index] !== true) continue;
    counters[poolName] = (index + 1) % pool.length;
    return { picked: pool[index] as string, index };
  }
  return undefined;
}

/**
 * Pick from a pool, honoring `persistCounters`. A persistence failure logs and
 * falls back to the in-memory counter (fail open) rather than aborting a spawn.
 */
async function pickForPool(
  pi: ExtensionApiLike,
  poolName: string,
  pool: string[],
  availability: PoolAvailability,
): Promise<{ picked: string; index: number; persisted: boolean } | undefined> {
  if (!activeConfig.persistCounters) {
    const pick = pickRoundRobin(poolName, pool, availability.eligible);
    return pick === undefined ? undefined : { ...pick, persisted: false };
  }
  try {
    const picked = await advancePersisted(poolName, pool.length, availability.eligible, activeConfig.stateFile);
    if (picked === undefined) return undefined;
    if (picked.replacedLegacy) {
      safeLog(
        pi,
        "warn",
        `[model-pool] replaced a version-1 state file at ${activeConfig.stateFile} (cursor semantics changed); ` +
          `the old file is kept at ${activeConfig.stateFile}.v1.bak and rotation continued from a fresh cursor`,
      );
    }
    counters[poolName] = (picked.index + 1) % pool.length; // mirror for diagnostics/tests
    return { picked: pool[picked.index] as string, index: picked.index, persisted: true };
  } catch (err) {
    safeLog(
      pi,
      "warn",
      `[model-pool] persisted counter read/write failed; using in-memory counters: ${err instanceof Error ? err.message : String(err)}`,
    );
    const pick = pickRoundRobin(poolName, pool, availability.eligible);
    return pick === undefined ? undefined : { ...pick, persisted: false };
  }
}

/** Human-readable routing note surfaced in the task UI. */
function describePick(poolName: string, picked: string, index: number, total: number): string {
  return `pool/${poolName}[${index + 1}/${total}]: ${picked}`;
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
 * When this OS process was born.
 *
 * Not module-load time: OMP materializes a fresh session's header during startup
 * *before* extensions load, so a module-load boundary classifies a brand-new
 * session as somebody else's and rotation never fires at all. Measured with
 * `process.uptime()` to recover the actual birth boundary.
 */
const PROCESS_BIRTH = Date.now() - Math.round(process.uptime() * 1000);

/**
 * Was this session created before this process started?
 *
 * This is the new-vs-resumed discriminator, and it deliberately does not consult
 * the filesystem. `/new` calls `ensureOnDisk()` before returning, and
 * `omp --session <missing path>` materializes a header immediately, so a
 * transcript can exist for a session that is genuinely new — reading a path
 * would suppress rotation for that new session, while a path that cannot be
 * statted would look absent and clobber a resumed one.
 *
 * The boundary is the process birth, with no tolerance window. Two earlier
 * attempts failed here and both are instructive:
 *
 * - a filesystem check cannot tell the two apart at all;
 * - module-load time with a five-second margin "worked" only by accident. A
 *   fresh header is written milliseconds before this module loads, so the margin
 *   classified it correctly, but the same margin also swallowed a metadata-only
 *   session closed and resumed moments after it was created — the exact
 *   `/new` → pick model → exit → resume case — and overwrote its restored model.
 *
 * Process birth separates them without a margin: a fresh header is written
 * after this process was born, and anything created by an earlier run is not,
 * however recent it was.
 *
 * `true` older (loaded), `false` created by this process, `undefined` when the
 * header is unavailable or unusable.
 */
function sessionPredatesProcess(manager: { getHeader?: () => unknown }): boolean | undefined {
  if (typeof manager.getHeader !== "function") return undefined;
  try {
    const header = manager.getHeader();
    if (header === null || typeof header !== "object") return undefined;
    const timestamp = (header as Record<string, unknown>)["timestamp"];
    if (typeof timestamp !== "string") return undefined;
    const createdAt = Date.parse(timestamp);
    if (!Number.isFinite(createdAt)) return undefined;
    return createdAt < PROCESS_BIRTH;
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
 * `true` new, `false` a loaded session whose transcript and model were
 * restored, `undefined` when the host exposes too little to tell. Only `true`
 * rotates: an unknown answer must never risk overriding a model that OMP just
 * restored.
 *
 * Two signals both mean "loaded": the header predates this process — the
 * discriminator that sees through `/new` and `--session <missing>` both
 * materializing a transcript for a new session — or the entries already hold a
 * conversational turn, which catches a restored transcript whatever the header
 * says.
 *
 * Only the header can prove the opposite. A session saved with no conversation
 * looks identical either way, so the entries can establish "loaded" and nothing
 * more: without a usable header timestamp this returns `undefined` and no
 * rotation happens, rather than assuming a resume is new.
 */
function sessionFreshness(ctx: ExtensionContextLike): boolean | undefined {
  const manager = ctx.sessionManager;
  if (manager === undefined) return undefined;
  const predates = sessionPredatesProcess(manager);
  const hasTurn = sessionHasConversationTurn(manager);
  if (predates === true || hasTurn === true) return false;
  return predates === false ? true : undefined;
}

// ---------------------------------------------------------------------------
// Event handlers.
// ---------------------------------------------------------------------------

/**
 * Carry a `pool/<name>:<level>` thinking suffix onto a member that has none.
 * Only a known level counts as a suffix: `kilo/x:free` keeps `:free` as part of
 * its id and still takes the pool's level (`kilo/x:free:high`).
 */
function withThinking(selector: string, thinking: string): string {
  if (thinking.length === 0) return selector;
  const colon = selector.lastIndexOf(":");
  if (colon !== -1 && THINKING_LEVELS[selector.slice(colon + 1)] === true) return selector;
  return `${selector}${thinking}`;
}

/** Bring config, provider registration and the forwarder's host handles up to date. */
function prepare(pi: ExtensionApiLike, ctx: ExtensionContextLike): void {
  captureHost(pi, ctx);
  refreshFromSource(pi);
  syncPoolProvider(pi, ctx.models);
}

/**
 * `before_subagent_spawn` handler: a child whose primary model is
 * `pool/<name>` starts on the next member in rotation, and the pool's other
 * eligible members become its retry fallbacks. Any other spawn is untouched:
 * a pool applies only where its model was chosen.
 */
async function handleBeforeSubagentSpawn(
  pi: ExtensionApiLike,
  event: BeforeSubagentSpawnEvent,
  ctx: ExtensionContextLike,
): Promise<BeforeSubagentSpawnResult | undefined> {
  try {
    prepare(pi, ctx);
    const patterns = Array.isArray(event.patterns) ? event.patterns : [];
    const selected = parsePoolSelector(patterns[0]);
    if (selected === undefined) return undefined;

    const pool = activeConfig.pools[selected.name];
    if (pool === undefined || pool.length === 0) {
      safeLog(pi, "warn", `[model-pool] agent=${event.agent} asked for pool/${selected.name}, which is not configured; leaving spawn unmodified`);
      return undefined;
    }

    const availability = filterAvailable(pool, ctx.models);
    if (availability.count === 0) {
      // Hard-block only when the registry actually answered "none of these are
      // authenticated"; an unreadable registry is a transient failure, not a
      // reason to refuse the spawn.
      if (isStrictForPool(selected.name) && availability.registryReadable) {
        return { block: true, reason: `model-pool: no authenticated model available in pool/${selected.name}` };
      }
      safeLog(pi, "warn", `[model-pool] empty pool/${selected.name} for agent=${event.agent} kind=${event.invocationKind} registryReadable=${availability.registryReadable}; leaving spawn unmodified`);
      return undefined;
    }

    const pick = await pickForPool(pi, selected.name, pool, availability);
    if (pick === undefined) return undefined;
    // Picked member first, then the rest of the pool in rotation order, then
    // whatever fallbacks the spawn already had. Each is a separate model for
    // the child's retry chain, never a switch inside one conversation.
    const ordered: string[] = [];
    for (let offset = 0; offset < pool.length; offset++) {
      const index = (pick.index + offset) % pool.length;
      if (availability.eligible[index] === true) ordered.push(withThinking(pool[index] as string, selected.thinking));
    }
    for (const fallback of patterns.slice(1)) {
      if (!ordered.includes(fallback)) ordered.push(fallback);
    }
    const note = describePick(selected.name, pick.picked, pick.index, pool.length);
    safeLog(pi, "info", `[model-pool] pool/${selected.name} agent=${event.agent} kind=${event.invocationKind} picked=${pick.picked} index=${pick.index} total=${pool.length} persisted=${pick.persisted}`);
    return { model: ordered, note };
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

/** Set once the role-named-pool notice has been shown in this process. */
let migrationNoticeShown = false;

/**
 * Pools used to apply to the role with the same name automatically. Point out
 * any pool still named after a role that does not select it, once per process.
 */
function noticeUnselectedRolePools(pi: ExtensionApiLike, ctx: ExtensionContextLike): void {
  if (migrationNoticeShown || ctx.models === undefined) return;
  migrationNoticeShown = true;
  const unused: string[] = [];
  for (const name of Object.keys(activeConfig.pools)) {
    let role: ModelLike | undefined;
    try {
      role = ctx.models.resolve(`@${name}`);
    } catch {
      role = undefined;
    }
    if (role === undefined || role === null) continue;
    if (modelIdentity(role) !== `${POOL_PROVIDER}/${name}`) unused.push(name);
  }
  if (unused.length === 0) return;
  const how = unused.map((name) => `${name} → pool/${name}`).join(", ");
  emit(
    pi,
    ctx,
    `pools now apply only where you select them; these are named after roles that do not use them: ${unused.join(", ")}. To keep rotating, set the role in /model or settings (${how}).`,
    "warning",
  );
}

/**
 * `session_start` handler. Every session refreshes the config and the `pool`
 * provider. A fresh main session whose model is `pool/<name>` switches to the
 * next member before its first turn; a resumed one keeps its model, and its
 * direct requests forward to a member pinned for that session.
 */
async function handleSessionStart(
  pi: ExtensionApiLike,
  _event: SessionStartEvent,
  ctx: ExtensionContextLike,
): Promise<void> {
  try {
    prepare(pi, ctx);
    if (ctx.agent?.kind !== "main") return; // A child's model was settled at spawn.
    noticeUnselectedRolePools(pi, ctx);

    const selected = parsePoolSelector(currentModelIdentity(ctx));
    if (selected === undefined) return;

    // `session_start` also fires for a *loaded* session, so a resume must never
    // re-rotate: OMP restores that session's saved model, and overriding it here
    // would change the model mid-conversation and invalidate prompt caches.
    const freshness = sessionFreshness(ctx);
    if (freshness !== true) {
      safeLog(pi, "info", `[model-pool] main session stays on pool/${selected.name} (${freshness === false ? "loaded session already has a conversation" : "session novelty unknown"}); requests forward to a member pinned for this session`);
      return;
    }

    const pool = activeConfig.pools[selected.name];
    if (pool === undefined || pool.length === 0) {
      emit(pi, ctx, `pool/${selected.name} is selected but not configured; add it with /model-pool edit`, "warning");
      return;
    }
    const availability = filterAvailable(pool, ctx.models);
    if (availability.count === 0) {
      safeLog(pi, "warn", `[model-pool] main session: empty pool/${selected.name} registryReadable=${availability.registryReadable}; leaving model unchanged`);
      return;
    }
    const pick = await pickForPool(pi, selected.name, pool, availability);
    if (pick === undefined) return;
    const note = describePick(selected.name, pick.picked, pick.index, pool.length);
    safeLog(pi, "info", `[model-pool] main session pool/${selected.name} picked=${pick.picked} index=${pick.index} total=${pool.length} persisted=${pick.persisted}`);
    // Applying the pick is a separate step from choosing it, and shares the
    // same host boundary the manual picker uses. A refusal, an unresolvable
    // selector, or a host that keeps a different model is never reported as a
    // successful rotation.
    // Carry the pool's own thinking level onto the member, so a fresh session
    // on `pool/x:high` starts at high instead of the member's default.
    const applied = withThinking(pick.picked, selected.thinking);
    const result = await applyModelToSession(pi, ctx, applied);
    if (!result.ok) {
      safeLog(pi, "warn", describeApplyFailure("main session", applied, result));
      return;
    }
    if (result.confirmed) {
      safeLog(pi, "info", `[model-pool] main session applied ${result.id}`);
      notifyUser(ctx, `model-pool: ${note}`, "info");
    } else {
      safeLog(
        pi,
        "warn",
        `[model-pool] main session: requested ${result.id} but the host did not confirm the active model`,
      );
      notifyUser(
        ctx,
        `model-pool: requested ${result.id}, but the host did not confirm the active model`,
        "warning",
      );
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
// Applying a model to the live session (shared by startup rotation and picker).
// ---------------------------------------------------------------------------

/** Why applying a model failed; the caller decides how to phrase the log. */
type ApplyModelResult =
  | {
      ok: true;
      id: string;
      /**
       * True only when the host reported the active model back and it matched.
       * A host that cannot report its active model is not evidence of failure,
       * but it is not evidence of success either, so callers must not present
       * an unconfirmed apply as a completed rotation.
       */
      confirmed: boolean;
    }
  | {
      ok: false;
      code: "unresolved" | "unauthenticated" | "registry-unreadable" | "no-set-model" | "refused" | "mismatch";
      detail: string;
    };

/**
 * Resolve, authenticate, apply and confirm one model on the live session.
 *
 * The host takes a resolved `Model`, not a selector string, and reports `false`
 * when it cannot apply one (no credential for that model). Confirmation via
 * `current()` is used when available but is not required: a host that cannot
 * report its active model must not turn a successful apply into a reported
 * failure, and must not turn a wrong model into a reported success either.
 *
 * A `setModel` that throws is deliberately not caught here — the caller's own
 * error handling decides what a thrown apply means.
 */
async function applyModelToSession(
  pi: ExtensionApiLike,
  ctx: ExtensionContextLike,
  selector: string,
): Promise<ApplyModelResult> {
  const models = ctx.models;
  if (models === undefined) return { ok: false, code: "registry-unreadable", detail: "no model registry" };

  let resolved: ModelLike | undefined;
  try {
    resolved = models.resolve(selector);
  } catch {
    resolved = undefined;
  }
  if (resolved === undefined || resolved === null || modelIdentity(resolved).length === 0) {
    return { ok: false, code: "unresolved", detail: `could not resolve ${selector}` };
  }

  let listed: ModelLike[];
  try {
    listed = models.list() ?? [];
  } catch {
    return { ok: false, code: "registry-unreadable", detail: "the model registry could not be read" };
  }
  const id = modelIdentity(resolved);
  const authenticated = new Set(listed.map(modelIdentity).filter((value) => value.length > 0));
  if (!authenticated.has(id)) {
    return { ok: false, code: "unauthenticated", detail: `${selector} is not authenticated` };
  }

  const setModel = pi.setModel;
  if (typeof setModel !== "function") {
    return { ok: false, code: "no-set-model", detail: "the host exposes no setModel" };
  }
  const applied = await setModel(resolved);
  if (applied === false) return { ok: false, code: "refused", detail: `the host refused ${selector}` };

  let currentId = "";
  try {
    const current = models.current?.();
    currentId = current === undefined || current === null ? "" : modelIdentity(current);
  } catch {
    currentId = "";
  }
  if (currentId.length > 0 && currentId !== id) {
    return { ok: false, code: "mismatch", detail: currentId };
  }
  return { ok: true, id, confirmed: currentId.length > 0 };
}

/** Phrase an apply failure for the log, keeping the established wording. */
function describeApplyFailure(context: string, selector: string, result: ApplyModelResult): string {
  if (result.ok) return "";
  switch (result.code) {
    case "unresolved":
      return `[model-pool] ${context}: host could not resolve ${selector}; leaving model unchanged`;
    case "no-set-model":
      return `[model-pool] ${context}: host exposes no setModel; leaving model unchanged`;
    case "refused":
      return `[model-pool] ${context}: host refused ${selector}; leaving model unchanged`;
    case "mismatch":
      return `[model-pool] ${context}: asked for ${selector} but the session reports ${result.detail}`;
    default:
      return `[model-pool] ${context}: could not apply ${selector} (${result.detail}); leaving model unchanged`;
  }
}

// ---------------------------------------------------------------------------
// Interactive command surface (`/model-pool`).
//
// The command is a convenience layer over the same engine the hooks use: it
// never changes the round-robin policy, never advances a counter, and never
// edits OMP's own role or settings files: a pool takes effect only where the
// operator selects `pool/<name>`. All dialogs are optional members of
// the host's UI surface, so every entry point degrades to a notification rather
// than assuming a dialog is available.
// ---------------------------------------------------------------------------

const COMMAND_NAME = "model-pool";
/** Sentinel option values; not valid pool names (they contain ":"). */
const NEW_POOL_VALUE = "::new-pool::";
const BACK_VALUE = "::back::";
/** Above this many models, ask for a substring before showing the list. */
const MODEL_FILTER_THRESHOLD = 12;

/** Best-effort notification: a broken UI must never break a command or a spawn. */
function notifyUser(ctx: ExtensionContextLike, message: string, type?: "info" | "warning" | "error"): void {
  try {
    ctx.ui?.notify?.(message, type);
  } catch {
    // Notification is best-effort.
  }
}

/** Log through the host and surface the same text to the user. */
function emit(pi: ExtensionApiLike, ctx: ExtensionContextLike, text: string, type: "info" | "warning" | "error" = "info"): void {
  safeLog(pi, type === "error" ? "error" : type === "warning" ? "warn" : "info", `[model-pool] ${text}`);
  notifyUser(ctx, text, type);
}

/** Is this the top-level session? Commands that mutate require it. */
function isMainAgent(ctx: ExtensionContextLike): boolean {
  return ctx.agent?.kind === "main";
}

/** Does the host expose the interactive dialogs the commands need? */
function hasInteractiveUI(ctx: ExtensionContextLike): boolean {
  return ctx.hasUI !== false && typeof ctx.ui?.select === "function" && typeof ctx.ui?.input === "function";
}

/** Is the session currently streaming? An unknown answer counts as not busy. */
function sessionBusy(ctx: ExtensionContextLike): boolean {
  try {
    return typeof ctx.isIdle === "function" && ctx.isIdle() === false;
  } catch {
    return false;
  }
}

/** Show a selector and map the returned label back to a value. */
async function pickLabeled<T>(
  ctx: ExtensionContextLike,
  title: string,
  items: { label: string; description?: string; value: T }[],
): Promise<T | undefined> {
  const ui = ctx.ui;
  if (ui === undefined || typeof ui.select !== "function") return undefined;
  const options: (string | UISelectItem)[] = items.map((item) =>
    item.description === undefined ? item.label : { label: item.label, description: item.description },
  );
  const chosen = await ui.select(title, options);
  if (chosen === undefined) return undefined;
  const found = items.find((item) => item.label === chosen);
  return found?.value;
}

/** Ask for a yes/no confirmation; a missing dialog counts as "no". */
async function confirmDialog(ctx: ExtensionContextLike, title: string, message: string): Promise<boolean> {
  const ui = ctx.ui;
  if (ui === undefined || typeof ui.confirm !== "function") return false;
  const answer = await ui.confirm(title, message);
  return answer === true;
}

/** Ask for one line of text; a missing dialog counts as cancelled. */
async function inputDialog(ctx: ExtensionContextLike, title: string, placeholder: string): Promise<string | undefined> {
  const ui = ctx.ui;
  if (ui === undefined || typeof ui.input !== "function") return undefined;
  return ui.input(title, placeholder);
}

/**
 * Authenticated models with a usable identity, or `undefined` when unreadable.
 *
 * De-duplicated by canonical identity: the picker selects by the *label* the
 * host returns, so two rows with the same identity would be ambiguous and the
 * first would silently win.
 */
function readAuthenticatedModels(ctx: ExtensionContextLike): ModelLike[] | undefined {
  const models = ctx.models;
  if (models === undefined) return undefined;
  try {
    const listed = models.list() ?? [];
    const seen = new Set<string>();
    const out: ModelLike[] = [];
    for (const model of listed) {
      const id = modelIdentity(model);
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      out.push(model);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Canonical identity of the session's current model; `""` when unknown. */
function currentModelIdentity(ctx: ExtensionContextLike): string {
  try {
    const current = ctx.models?.current?.();
    return current === undefined || current === null ? "" : modelIdentity(current);
  } catch {
    return "";
  }
}

/** Pick one model from the authenticated list, with an optional substring filter. */
async function chooseModel(ctx: ExtensionContextLike, models: ModelLike[], title: string): Promise<string | undefined> {
  let candidates = models;
  if (candidates.length > MODEL_FILTER_THRESHOLD) {
    const filter = await inputDialog(ctx, "Filter models", "substring, empty for all");
    if (filter === undefined) return undefined;
    const needle = filter.trim().toLowerCase();
    if (needle.length > 0) {
      candidates = candidates.filter((m) => modelIdentity(m).toLowerCase().includes(needle));
      if (candidates.length === 0) {
        notifyUser(ctx, `model-pool: no model matches "${filter.trim()}"`, "warning");
        return undefined;
      }
    }
  }
  const currentId = currentModelIdentity(ctx);
  const items = candidates.map((m) => {
    const id = modelIdentity(m);
    return id === currentId ? { label: id, description: "current", value: id } : { label: id, value: id };
  });
  return pickLabeled(ctx, title, items);
}

/** Ask which configured slot to act on; returns the zero-based index. */
async function pickSlot(ctx: ExtensionContextLike, title: string, pool: string[]): Promise<number | undefined> {
  const items = pool.map((selector, index) => ({ label: `${index + 1}. ${selector}`, value: index }));
  return pickLabeled(ctx, title, items);
}

/** One-line description of the active configuration source, safe to display. */
function describeSource(): string {
  const mode = editMode();
  const label = mode === "file" ? "saved to file" : mode === "runtime-only" ? "runtime-only" : "editing disabled";
  const note = configSource.note === undefined ? "" : `; ${configSource.note}`;
  return `source: ${configSource.label} (${configSource.kind}, ${label})${note}`;
}

/**
 * One-line pre-edit summary of the pool about to be edited: configured order
 * with authenticated membership, counter policy, and the cursor guarantee.
 * Read-only, so merely entering the editor still changes nothing.
 */
function describePoolForEditing(name: string, pool: string[], models: ModelsQuery | undefined): string {
  if (pool.length === 0) {
    return `model-pool: pool/${name} has no models yet — adding one creates it, and the order decides the rotation sequence`;
  }
  const report = diagnosePools(models);
  const entries = report.pools.find((diagnosis) => diagnosis.pool === name)?.entries ?? [];
  const order = report.registryReadable
    ? pool
        .map((selector, i) => {
          const entry = entries[i];
          const state = entry === undefined || entry.eligible ? "available" : `unavailable: ${entry.reason}`;
          return `${i + 1}. ${selector} (${state})`;
        })
        .join(", ")
    : `${pool.map((selector, i) => `${i + 1}. ${selector}`).join(", ")} (availability unknown: model registry unavailable)`;
  const policy = activeConfig.persistCounters
    ? `counters persist across processes (${activeConfig.stateFile})`
    : "counters are process-local";
  return `model-pool: pool/${name} order: ${order} — ${policy}; editing never moves the cursor`;
}

/**
 * Report the outcome of a save attempt and, on success, refresh the `pool`
 * provider so an added or deleted pool shows up in the model picker at once.
 */
function reportEditOutcome(
  pi: ExtensionApiLike,
  ctx: ExtensionContextLike,
  outcome: PoolEditOutcome,
  successMessage: string,
): boolean {
  if (!outcome.ok) {
    notifyUser(ctx, `model-pool: ${outcome.error}`, "error");
    return false;
  }
  syncPoolProvider(pi, ctx.models);
  const suffix = outcome.runtimeOnly ? " (runtime-only; not written to disk)" : "";
  notifyUser(ctx, `model-pool: ${successMessage}${suffix}`, "info");
  return true;
}

/** `/model-pool pick`: switch the current main-session model. */
async function runModelPicker(pi: ExtensionApiLike, ctx: ExtensionContextLike): Promise<void> {
  if (!isMainAgent(ctx)) {
    notifyUser(ctx, "model-pool: switching the model is available in the main session only", "warning");
    return;
  }
  if (!hasInteractiveUI(ctx)) {
    notifyUser(ctx, "model-pool: switching the model needs an interactive session", "warning");
    return;
  }
  if (sessionBusy(ctx)) {
    notifyUser(ctx, "model-pool: the session is busy; try again when it is idle", "warning");
    return;
  }
  const models = readAuthenticatedModels(ctx);
  if (models === undefined) {
    notifyUser(ctx, "model-pool: the model registry is unavailable", "error");
    return;
  }
  if (models.length === 0) {
    notifyUser(ctx, "model-pool: no authenticated models are available", "warning");
    return;
  }
  const currentId = currentModelIdentity(ctx);
  const chosen = await chooseModel(
    ctx,
    models,
    "Switch current model (changes this conversation; may affect prompt caching)",
  );
  if (chosen === undefined) {
    notifyUser(ctx, "model-pool: cancelled", "info");
    return;
  }
  if (chosen === currentId) {
    notifyUser(ctx, `model-pool: already using ${chosen}`, "info");
    return;
  }
  // Re-check after the dialog: the session may have started streaming while the
  // user was choosing, and switching mid-turn is not safe.
  if (sessionBusy(ctx)) {
    notifyUser(ctx, "model-pool: the session became busy; not switching", "warning");
    return;
  }
  try {
    const result = await applyModelToSession(pi, ctx, chosen);
    if (!result.ok) {
      const message =
        result.code === "mismatch"
          ? `model-pool: requested ${chosen}, but the session still reports ${result.detail}`
          : `model-pool: ${result.detail}`;
      notifyUser(ctx, message, "error");
      return;
    }
    if (result.confirmed) {
      notifyUser(ctx, `model-pool: switched to ${result.id}`, "info");
    } else {
      notifyUser(
        ctx,
        `model-pool: requested ${result.id}, but the host did not confirm the active model`,
        "warning",
      );
    }
  } catch (err) {
    notifyUser(ctx, `model-pool: switch failed (${err instanceof Error ? err.message : String(err)})`, "error");
  }
}

/** `/model-pool edit [pool]`: add, remove, reorder or delete pools. */
async function runPoolEditor(pi: ExtensionApiLike, ctx: ExtensionContextLike, initialPool?: string): Promise<void> {
  if (!isMainAgent(ctx)) {
    notifyUser(ctx, "model-pool: editing pools is available in the main session only", "warning");
    return;
  }
  if (!hasInteractiveUI(ctx)) {
    notifyUser(ctx, "model-pool: editing pools needs an interactive session", "warning");
    return;
  }
  if (editMode() === "disabled") {
    notifyUser(
      ctx,
      `model-pool: pool editing is disabled until the configuration source is repaired — ${describeSource()}`,
      "warning",
    );
    return;
  }
  let name = normalizePoolName(initialPool ?? "");
  let announced = "";

  for (;;) {
    if (name.length === 0) {
      const pools = getPools();
      const items: { label: string; description?: string; value: string }[] = Object.keys(pools).map((key) => {
        const count = pools[key]?.length ?? 0;
        return { label: `pool/${key}`, description: `${count} ${count === 1 ? "model" : "models"}`, value: key };
      });
      items.push({ label: "New pool…", description: "create a pool you can select as a model", value: NEW_POOL_VALUE });
      items.push({ label: "Back", description: "close the editor", value: BACK_VALUE });
      const picked = await pickLabeled(ctx, `Pools — ${describeSource()}`, items);
      if (picked === undefined || picked === BACK_VALUE) return;
      if (picked === NEW_POOL_VALUE) {
        const entered = await inputDialog(ctx, "New pool name", "for example: cheap-coders (becomes pool/cheap-coders)");
        if (entered === undefined) continue;
        const key = normalizePoolName(entered);
        if (key.length === 0 || !POOL_NAME_PATTERN.test(key)) {
          notifyUser(ctx, 'model-pool: a pool name needs letters, digits, ".", "_" or "-"', "warning");
          continue;
        }
        if (getPools()[key] === undefined) {
          notifyUser(
            ctx,
            `model-pool: pool/${key} takes effect only where you select it: /model, a role in settings, or an agent's model`,
            "info",
          );
        }
        name = key;
        continue;
      }
      name = picked;
      continue;
    }

    const pool = getPools()[name] ?? [];
    // Capture the revision before any await: an edit committed after this point
    // by another command makes this editor's next write stale, and it refreshes
    // instead of overwriting.
    const revision = configRevision;
    // Announce once per pool entry, not after every action, so order and
    // availability are shown before editing without becoming noise.
    if (announced !== name) {
      announced = name;
      notifyUser(ctx, describePoolForEditing(name, pool, ctx.models), "info");
    }
    const items: { label: string; description?: string; value: string }[] = [
      { label: "Add model…", description: "append a model to this pool", value: "add" },
    ];
    if (pool.length > 0) {
      items.push({ label: "Remove entry…", value: "remove" });
      items.push({ label: "Move earlier…", value: "earlier" });
      items.push({ label: "Move later…", value: "later" });
      items.push({ label: "Delete pool", description: "remove the pool entirely", value: "delete" });
    }
    items.push({ label: "Back", description: "choose another pool", value: "back" });

    const heading = `pool/${name} (${pool.length} ${pool.length === 1 ? "model" : "models"}) — ${describeSource()}`;
    const action = await pickLabeled(ctx, heading, items);
    if (action === undefined || action === "back") {
      name = "";
      continue;
    }

    if (action === "add") {
      const models = readAuthenticatedModels(ctx)?.filter((model) => model.provider !== POOL_PROVIDER);
      if (models === undefined) {
        notifyUser(ctx, "model-pool: the model registry is unavailable", "error");
        continue;
      }
      if (models.length === 0) {
        notifyUser(ctx, "model-pool: no authenticated models are available", "warning");
        continue;
      }
      const chosen = await chooseModel(ctx, models, `Add a model to pool/${name}`);
      if (chosen === undefined) continue;
      // The dialog may outlive the snapshot: re-resolve against the live registry
      // so a model that lost authentication while the picker was open is not
      // saved and then reported as added.
      if (filterAvailable([chosen], ctx.models).eligible[0] !== true) {
        notifyUser(ctx, `model-pool: ${chosen} is no longer authenticated; not added to pool/${name}`, "warning");
        continue;
      }
      const outcome = await savePoolEdit(name, [...pool, chosen], revision);
      reportEditOutcome(pi, ctx, outcome, `added ${chosen} to pool/${name} (slot ${pool.length + 1})`);
      continue;
    }

    if (action === "remove") {
      const index = await pickSlot(ctx, `Remove an entry from pool/${name}`, pool);
      if (index === undefined) continue;
      const remaining = pool.filter((_, i) => i !== index);
      if (remaining.length === 0) {
        const ok = await confirmDialog(
          ctx,
          `Delete pool/${name}?`,
          "This is the last entry, so the pool is removed; anything still set to it stops resolving.",
        );
        if (!ok) continue;
      }
      const outcome = await savePoolEdit(name, remaining.length === 0 ? null : remaining, revision);
      reportEditOutcome(
        pi,
        ctx,
        outcome,
        remaining.length === 0 ? `deleted pool/${name}` : `removed slot ${index + 1} from pool/${name}`,
      );
      continue;
    }

    if (action === "earlier" || action === "later") {
      const index = await pickSlot(ctx, `Move which entry of pool/${name}?`, pool);
      if (index === undefined) continue;
      const target = action === "earlier" ? index - 1 : index + 1;
      if (target < 0 || target >= pool.length) {
        notifyUser(ctx, "model-pool: that entry is already at the end of the pool", "warning");
        continue;
      }
      const next = [...pool];
      const moved = next[index] as string;
      next[index] = next[target] as string;
      next[target] = moved;
      const outcome = await savePoolEdit(name, next, revision);
      reportEditOutcome(pi, ctx, outcome, `moved ${moved} to slot ${target + 1}`);
      continue;
    }

    if (action === "delete") {
      const ok = await confirmDialog(
        ctx,
        `Delete pool/${name}?`,
        `pool/${name} is removed; anything still set to it stops resolving.`,
      );
      if (!ok) continue;
      const outcome = await savePoolEdit(name, null, revision);
      reportEditOutcome(pi, ctx, outcome, `deleted pool/${name}`);
      name = "";
      continue;
    }
  }
}

/**
 * Human-readable editability of the active source, for `status`/`doctor`.
 *
 * `configSource.writable` alone conflates two different outcomes: a
 * runtime-only source (programmatic options, inline JSON) still accepts edits
 * into memory, whereas a disabled source (an unreadable file, or one shadowed
 * by a malformed higher-priority source) refuses them. Operators need to see
 * which one they have.
 */
function sourceStatusLabel(): "writable" | "runtime-only" | "editing disabled" {
  const mode = editMode();
  return mode === "file" ? "writable" : mode === "runtime-only" ? "runtime-only" : "editing disabled";
}

/** `/model-pool status`: read-only summary; never writes. */
function runStatus(pi: ExtensionApiLike, ctx: ExtensionContextLike): void {
  const pools = getPools();
  const names = Object.keys(pools);
  const lines = [
    `config: ${configSource.label} (${configSource.kind}, ${sourceStatusLabel()})`,
  ];
  if (configSource.note !== undefined) lines.push(`config note: ${configSource.note}`);
  lines.push(
    `strict: ${Array.isArray(activeConfig.strict) ? activeConfig.strict.join(", ") || "none" : String(activeConfig.strict)}`,
  );
  lines.push(`persistence: ${activeConfig.persistCounters ? activeConfig.stateFile : "off (in-memory counters only)"}`);
  lines.push(
    `pools: ${names.length === 0 ? "none configured" : names.map((key) => `pool/${key}[${pools[key]?.length ?? 0}]`).join(", ")}`,
  );
  if (names.length > 0) lines.push("a pool applies only where it is selected: /model, a role in settings, or an agent's model");
  lines.push(`current model: ${currentModelIdentity(ctx) || "unknown"}`);
  for (const key of names) {
    const entries = (pools[key] ?? []).map((selector, index) => `${index + 1}. ${selector}`).join("  ");
    lines.push(`  pool/${key}: ${entries}`);
  }
  lines.push(`counters (process-local): ${JSON.stringify(getCounters())}`);
  emit(pi, ctx, lines.join("\n"), "info");
}

/** `/model-pool doctor`: per-entry diagnosis; read-only. */
function runDoctor(pi: ExtensionApiLike, ctx: ExtensionContextLike): void {
  const report = diagnosePools(ctx.models);
  const lines = [`registry: ${report.registryNote}`];
  if (report.pools.length === 0) lines.push("no pools configured");
  for (const diagnosis of report.pools) {
    lines.push(`pool/${diagnosis.pool}:`);
    for (const entry of diagnosis.entries) {
      lines.push(`  ${entry.eligible ? "ok" : "unavailable"}: ${entry.selector} — ${entry.reason}`);
    }
  }
  lines.push(`config: ${configSource.label} (${configSource.kind}, ${sourceStatusLabel()})`);
  lines.push(`state: ${activeConfig.persistCounters ? activeConfig.stateFile : "persistence off"}`);
  emit(pi, ctx, lines.join("\n"), "info");
}

/** `/model-pool help`. */
function runHelp(pi: ExtensionApiLike, ctx: ExtensionContextLike): void {
  emit(
    pi,
    ctx,
    [
      "/model-pool — round-robin model pool",
      "  (no argument)  open the menu",
      "  pick           switch the current main-session model",
      "  edit [pool]    add, remove, reorder or delete pools (auto-saved)",
      "  status         show the active configuration and pools",
      "  doctor         per-entry authentication diagnosis (read-only)",
      "  help           show this help",
    ].join("\n"),
    "info",
  );
}

/** The no-argument menu. */
async function runMenu(pi: ExtensionApiLike, ctx: ExtensionContextLike): Promise<void> {
  if (!hasInteractiveUI(ctx)) {
    runHelp(pi, ctx);
    return;
  }
  const picked = await pickLabeled(ctx, "Model pool", [
    { label: "Switch Current Model", description: "change this session's model", value: "pick" },
    { label: "Edit Pools", description: "add, remove, reorder or delete pools", value: "edit" },
    { label: "Status", description: "show configuration and pools", value: "status" },
    { label: "Doctor", description: "diagnose model availability", value: "doctor" },
    { label: "Help", description: "show command usage", value: "help" },
  ]);
  if (picked === undefined) return;
  await dispatchCommand(pi, ctx, picked);
}

/** Route `/model-pool` arguments. */
async function dispatchCommand(pi: ExtensionApiLike, ctx: ExtensionContextLike, rawArgs: string): Promise<void> {
  // Commands show and edit the live configuration, so bring it up to date first.
  prepare(pi, ctx);
  const args = rawArgs.trim();
  if (args.length === 0) {
    await runMenu(pi, ctx);
    return;
  }
  const [head, ...rest] = args.split(/\s+/);
  const command = (head ?? "").toLowerCase();
  const tail = rest.join(" ");
  switch (command) {
    case "pick":
      await runModelPicker(pi, ctx);
      return;
    case "edit":
      await runPoolEditor(pi, ctx, tail);
      return;
    case "status":
      runStatus(pi, ctx);
      return;
    case "doctor":
      runDoctor(pi, ctx);
      return;
    case "help":
      runHelp(pi, ctx);
      return;
    default:
      emit(pi, ctx, `unknown argument "${command}"; use /model-pool help`, "warning");
  }
}

/** Register `/model-pool` if the host supports commands; never fatal. */
function registerCommandSurface(pi: ExtensionApiLike): void {
  if (typeof pi.registerCommand !== "function") {
    safeLog(
      pi,
      "warn",
      "[model-pool] host exposes no registerCommand; /model-pool is unavailable (pool rotation is unaffected)",
    );
    return;
  }
  try {
    pi.registerCommand(COMMAND_NAME, {
      description: "Model pools you select as pool/<name>: edit pools or switch the current model",
      handler: (args, ctx) => dispatchCommand(pi, ctx, args),
    });
    safeLog(pi, "info", `[model-pool] registered /${COMMAND_NAME}`);
  } catch (err) {
    safeLog(
      pi,
      "warn",
      `[model-pool] could not register /${COMMAND_NAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Extension factory (default export; OMP calls it with the ExtensionAPI).
// ---------------------------------------------------------------------------

/**
 * Extension factory: load configuration, register the `pool` provider and
 * both event handlers, then the optional command surface.
 *
 * Programmatic `options` are an unconditional replacement and are runtime-only.
 * Without options the environment/default source is loaded; when the factory is
 * re-bound to a child session with the *same* source it deliberately keeps any
 * runtime edits instead of resetting to the on-disk document.
 */
export default function modelPoolExtension(pi: ExtensionApiLike, options?: ModelPoolConfig): void {
  if (options !== undefined) {
    const normalized = normalizeConfig(options);
    const signature = `options:${optionsSignature(normalized)}`;
    // Same guard as the environment source: a re-bind for a child session with
    // identical options must not discard runtime-only edits made since.
    if (signature !== loadedSignature) {
      applyNormalized(normalized);
      configSource = {
        kind: "options",
        writable: false,
        label: "programmatic options",
        note: "runtime-only: options cannot be rewritten",
      };
      configShape = "none";
      configFingerprint = undefined;
      configRevision += 1;
      loadedSignature = signature;
      for (const warning of normalized.warnings) safeLog(pi, "warn", `[model-pool] ${warning}`);
    }
  } else {
    // A factory call without options always reads the environment source, even
    // after an earlier options load; the hooks' refresh leaves options alone.
    const loaded = loadConfigWithSource();
    const signature = sourceSignature(loaded.source, loaded.fingerprint);
    if (signature !== loadedSignature) {
      const warnings = configureLoaded(loaded);
      loadedSignature = signature;
      for (const warning of warnings) safeLog(pi, "warn", `[model-pool] ${warning}`);
    }
  }

  const pools = Object.keys(activeConfig.pools);
  safeLog(
    pi,
    "info",
    `[model-pool] loaded pools=[${pools.map((name) => `pool/${name}`).join(", ")}] strict=${Array.isArray(activeConfig.strict) ? activeConfig.strict.join(",") : String(activeConfig.strict)} persist=${activeConfig.persistCounters ? activeConfig.stateFile : "off"} source=${configSource.kind}`,
  );

  // Pools exist as models before any session starts, so `--model pool/<name>`
  // and roles that name one resolve. Limits are refined once a registry is seen.
  syncPoolProvider(pi, undefined);
  loadPiAi(pi);

  // Routing hooks are registered first and independently of the command
  // surface: a host that cannot register commands must still rotate pools.
  pi.on("before_subagent_spawn", (event, ctx) =>
    handleBeforeSubagentSpawn(pi, event as BeforeSubagentSpawnEvent, ctx as ExtensionContextLike),
  );
  pi.on("session_start", (event, ctx) =>
    handleSessionStart(pi, event as SessionStartEvent, ctx as ExtensionContextLike),
  );

  registerCommandSurface(pi);
}
