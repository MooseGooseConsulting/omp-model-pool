// omp-musical-models — per-role round-robin model cycling for oh-my-pi.
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
  /** State file for `persistCounters`. Default: `OMP_MODEL_POOL_STATE` or `~/.omp/agent/model-musical-models-state.json`. */
  stateFile?: string;
}

// ---------------------------------------------------------------------------
// Module-level shared state (in-process round-robin counters).
// ---------------------------------------------------------------------------

const counters: Record<string, number> = Object.create(null);

/** State file name under the OMP agent dir when no explicit/env path is given. */
const DEFAULT_STATE_FILE = "model-musical-models-state.json";
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

/** Resolve the state file: explicit option > `OMP_MODEL_POOL_STATE` > OMP agent dir. */
export function resolveStateFilePath(explicit?: string): string {
  const fromOption = typeof explicit === "string" ? explicit.trim() : "";
  if (fromOption.length > 0) return path.resolve(fromOption);
  const fromEnv = process.env["OMP_MODEL_POOL_STATE"];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".omp", "agent", DEFAULT_STATE_FILE);
}

/** Parse `{ version: 1, counters: { role: int } }`; undefined when malformed. */
function parseState(raw: string): Record<string, number> | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const rawCounters = (obj as Record<string, unknown>)["counters"];
  if (rawCounters === null || typeof rawCounters !== "object" || Array.isArray(rawCounters)) return undefined;
  const out: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(rawCounters as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

/** Read counters from disk. Missing file → empty; malformed file → throw (no silent reset). */
function readPersistedCounters(file: string): Record<string, number> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
    throw err;
  }
  const parsed = parseState(raw);
  if (parsed === undefined) throw new Error(`invalid model-pool state at ${file}`);
  return parsed;
}

/** Write the state via a unique temp file + atomic rename (mode 0600). */
function writeStateAtomic(file: string, next: Record<string, number>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, counters: next }, null, 2)}\n`, {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` while holding an atomic-directory lock; stale locks are reclaimed. */
async function withStateLock<T>(file: string, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for model-pool lock ${lock}`);
      await sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // Lock release is best-effort.
    }
  }
}

/** Atomically select and advance the role cursor in the shared state file. */
function advancePersisted(roleKey: string, poolLength: number, file: string): Promise<{ slot: number }> {
  return withStateLock(file, () => {
    const persisted = readPersistedCounters(file);
    const cursor = persisted[roleKey] ?? 0;
    const slot = poolLength === 0 ? 0 : cursor % poolLength;
    persisted[roleKey] = cursor + 1;
    writeStateAtomic(file, persisted);
    return { slot };
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
    persistCounters: raw?.persistCounters ?? false,
    stateFile: resolveStateFilePath(raw?.stateFile),
  };
}

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
      if (parsed !== null && typeof parsed === "object") {
        if (Array.isArray(parsed)) return { pools: Object.create(null) };
        if ("pools" in (parsed as Record<string, unknown>)) {
          return parsed as ModelPoolConfig;
        }
        return { pools: parsed as Record<string, string[]> };
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
      if ("pools" in (parsed as Record<string, unknown>)) return parsed as ModelPoolConfig;
      return { pools: parsed as Record<string, string[]> };
    }
  }
  return { pools: Object.create(null) };
}

// ---------------------------------------------------------------------------
// Core helpers.
// ---------------------------------------------------------------------------

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

function isStrictForRole(roleKey: string): boolean {
  const { strict } = activeConfig;
  if (strict === true) return true;
  if (Array.isArray(strict)) return strict.map((r) => normalizeRoleKey(r)).includes(roleKey);
  return false;
}

function modelIdentity(m: ModelLike): string {
  const provider = typeof m.provider === "string" && m.provider.length > 0 ? `${m.provider}/` : "";
  return typeof m.id === "string" && m.id.length > 0 ? `${provider}${m.id}` : "";
}

/**
 * Keep pool entries that resolve AND are present in the authenticated list.
 * Returns the surviving selectors in pool order (original strings preserved so
 * the child re-resolves exactly what the operator configured).
 */
function filterAvailable(selectors: string[], models: ModelsQuery | undefined): string[] {
  if (models === undefined) return [];
  let available: ModelLike[];
  try {
    available = models.list() ?? [];
  } catch {
    return [];
  }
  const identities = new Set<string>();
  for (const m of available) {
    const id = modelIdentity(m);
    if (id.length > 0) identities.add(id);
  }
  const out: string[] = [];
  for (const selector of selectors) {
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
    if (id.length > 0 && !identities.has(id) && available.length > 0) continue;
    out.push(selector);
  }
  return out;
}

/** Advance the role counter and return the pick plus its pool position. */
function pickRoundRobin(roleKey: string, available: string[]): { picked: string; index: number } {
  const cursor = counters[roleKey] ?? 0;
  const slot = available.length === 0 ? 0 : cursor % available.length;
  const picked = available[slot] as string;
  counters[roleKey] = cursor + 1;
  return { picked, index: slot };
}

/**
 * Pick for a role, honoring `persistCounters`. A persistence failure logs and
 * falls back to the in-memory counter (fail open) rather than aborting a spawn.
 */
async function pickForRole(
  pi: ExtensionApiLike,
  roleKey: string,
  available: string[],
): Promise<{ picked: string; index: number; persisted: boolean }> {
  if (!activeConfig.persistCounters) {
    return { ...pickRoundRobin(roleKey, available), persisted: false };
  }
  try {
    const { slot } = await advancePersisted(roleKey, available.length, activeConfig.stateFile);
    counters[roleKey] = (counters[roleKey] ?? 0) + 1; // mirror for diagnostics/tests
    return { picked: available[slot] as string, index: slot, persisted: true };
  } catch (err) {
    safeLog(
      pi,
      "warn",
      `[model-pool] persisted counter read/write failed; using in-memory counters: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...pickRoundRobin(roleKey, available), persisted: false };
  }
}

function describePick(roleKey: string, picked: string, index: number, total: number): string {
  return `pool ${roleKey}[${index + 1}/${total}]: ${picked}`;
}

// ---------------------------------------------------------------------------
// Event handlers.
// ---------------------------------------------------------------------------

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

    const available = filterAvailable(pool, ctx.models);
    if (available.length === 0) {
      safeLog(pi, "warn", `[model-pool] empty pool for role=${roleKey} agent=${event.agent} kind=${event.invocationKind}; leaving spawn unmodified`);
      if (isStrictForRole(roleKey)) {
        return { block: true, reason: `model-pool: no authenticated model available for role @${roleKey}` };
      }
      return undefined;
    }

    if (activeConfig.persistCounters) {
      return pickForRole(pi, roleKey, available).then(({ picked, index, persisted }) => {
        const note = describePick(roleKey, picked, index, available.length);
        safeLog(pi, "info", `[model-pool] role=${roleKey} agent=${event.agent} kind=${event.invocationKind} picked=${picked} index=${index} total=${available.length} persisted=${persisted}`);
        return { model: picked, note };
      });
    }
    const { picked, index } = pickRoundRobin(roleKey, available);
    const note = describePick(roleKey, picked, index, available.length);
    safeLog(pi, "info", `[model-pool] role=${roleKey} agent=${event.agent} kind=${event.invocationKind} picked=${picked} index=${index} total=${available.length}`);
    return { model: picked, note };
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

async function handleSessionStart(
  pi: ExtensionApiLike,
  _event: SessionStartEvent,
  ctx: ExtensionContextLike,
): Promise<void> {
  try {
    if (!activeConfig.enableMainSessionRotation) return;
    if (ctx.agent?.kind !== "main") return; // Main sessions only.
    const roleKey = activeConfig.mainSessionRole;
    const pool = activeConfig.pools[roleKey];
    if (pool === undefined || pool.length === 0) return;

    const available = filterAvailable(pool, ctx.models);
    if (available.length === 0) {
      safeLog(pi, "warn", `[model-pool] main session: empty pool for role=${roleKey}; leaving model unchanged`);
      return;
    }
    const { picked, index, persisted } = await pickForRole(pi, roleKey, available);
    const note = describePick(roleKey, picked, index, available.length);
    safeLog(pi, "info", `[model-pool] main session role=${roleKey} picked=${picked} index=${index} total=${available.length} persisted=${persisted}`);
    if (typeof pi.setModel === "function") {
      await pi.setModel(picked);
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
