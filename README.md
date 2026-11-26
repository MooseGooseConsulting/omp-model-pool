# omp-model-pool

Round-robin model rotation: every new subagent spawn takes the next model in
its role's pool.

Standalone [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that
cycles the model **by role** on every new subagent spawn. The agent definition
never changes; only the model it runs on rotates.

Every child resolving via `@slow` gets `slow[0]`, then `slow[1]`, then
`slow[2]`, then wraps — regardless of whether the agent was `reviewer`,
`scout`, or `task`. Agent names are logged, never used as the counter key.

Authoritative event reference:
`can1357/oh-my-pi` main `docs/extensions.md`
(`before_subagent_spawn → { model, block, reason, note }`).
The `omp.sh` site docs omit this event; the GitHub doc wins on conflict.

## Install

Dev / local link:

```bash
omp --extension ./omp-model-pool
# or
omp plugin link ./omp-model-pool
```

The manifest entry is `omp.extensions: ["./src/index.ts", "./src/mistral-live.ts"]` in
`package.json`; no OMP fork is required. Distribute via npm or a
Git/marketplace entry.

## Included extension: `mistral-live`

`./src/mistral-live.ts` registers Mistral with `fetchDynamicModels` so OMP treats
Mistral's live `GET /v1/models` chat roster (`capabilities.completion_chat === true`)
as authoritative instead of merging retired static bundled IDs that fail at runtime
with `HTTP 400 invalid_model`.

- **Zero hardcoded model IDs:** newly released Mistral chat models appear
  automatically on refresh; retired IDs disappear automatically.
- **Auth preserved:** uses your existing OMP Mistral credential without overriding
  `apiKey`.
- **Fail-safe cache fallback:** network/auth/schema failures throw so OMP keeps
  its last cached catalog rather than emptying Mistral models.
- **Controls:** set `OMP_MISTRAL_LIVE_BASE_URL` for a custom Mistral-compatible
  endpoint, or `OMP_MISTRAL_LIVE_DISABLE=1` to disable the extension without
  uninstalling the package.

## Configure

Pools are keyed by **bare role name** (`slow`, `smol`, …) holding selectors in
cycle order. Unconfigured roles return nothing and core behavior is unchanged.
Only roles you configure cycle.

```jsonc
// model-pool.json (see model-pool.example.json)
{
  "pools": {
    "slow": ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"],
    "default": ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"]
  },
  "mainSessionRole": "default",      // role rotated by session_start (bare name)
  "enableMainSessionRotation": true, // false keeps subagent cycling only
  "strict": false,                   // true | ["slow"] blocks empty-pool spawns
  "persistCounters": false           // true shares the cycle across OMP processes
}
```

Flat shorthand (`{ "slow": [...] }`) is also accepted. Sources, in precedence
order:

1. Programmatic `options` passed to the factory (tests / hosts) — runtime-only.
2. `OMP_MODEL_POOLS_JSON` — inline JSON (object with `pools` or flat map) —
   runtime-only.
3. `OMP_MODEL_POOL_CONFIG` — path to an explicit JSON file as above.
4. `<OMP agent dir>/model-pool.json` — the profile-scoped default file.
5. Empty.

Sources 1 and 2 are **runtime-only**: they live in memory, are never rewritten,
and any pool edit made against them is labelled runtime-only and lost when the
process exits. Sources 3 and 4 are authoritative files, so accepted edits are
saved back to them automatically (see *Automatic saving*). Because the two
runtime sources outrank every file, while they are in effect the editor changes
the in-memory pools only.

`stateFile` also honors `OMP_MODEL_POOL_STATE` when the option is unset. A
relative `stateFile` path resolves against the OMP agent dir, never the process
CWD, so processes started from different directories still share one cycle; a
leading `~` resolves against the home directory. The explicit config file
(`OMP_MODEL_POOL_CONFIG`) is the exception: a relative path there resolves
against the process CWD, as before. The profile default file always lives at
`<OMP agent dir>/model-pool.json`.

The agent dir follows OMP's own resolution rather than assuming the default
profile: the config root is `~/<PI_CONFIG_DIR or .omp>`, a named profile
(`OMP_PROFILE`, or the legacy `PI_PROFILE`) relocates it to
`<root>/profiles/<name>/agent`, and `PI_CODING_AGENT_DIR` applies to the
default profile only — a named profile ignores it. So **by default** two
profiles get separate counter files, and a profile does not write state into
another profile's directory. An explicit `stateFile` (or
`OMP_MODEL_POOL_STATE`) overrides all of that and is taken literally, so
pointing two profiles at one path deliberately shares their cycle. XDG
relocation is **not** followed; set `stateFile` explicitly on a host that moved
its agent directory with `omp config init-xdg`.

```bash
export OMP_MODEL_POOL_CONFIG=./model-pool.json
export OMP_MODEL_POOLS_JSON='{"slow":["anthropic/claude-haiku-4-5","openai/gpt-5-mini"]}'
omp --extension ./omp-model-pool
```

### First-run setup

With no source configured the extension loads, reads nothing, and rotates
nothing. To give it a persistent home, either point `OMP_MODEL_POOL_CONFIG` at
a file, copy `model-pool.example.json` to `<OMP agent dir>/model-pool.json`, or
just open `/model-pool` and add a model to a role: the first confirmed edit
creates the profile-scoped default file in the nested shape. Loading the
extension, running `status`/`doctor`, or opening the editor never creates a
file on its own.

### Automatic saving

Each accepted pool edit is its own transaction. When a file is authoritative,
the edit is written immediately: the file's unrelated top-level keys and
unedited selectors are preserved, an existing file keeps its flat-vs-nested
shape, and a newly created default file uses the nested shape. Writes are
serialized with an atomic-directory lock on the config path, re-read and
fingerprint-checked after the lock is acquired, written through an exclusive
temp file plus atomic rename, and the in-memory pools are replaced only after
the file commit succeeds — a failed save leaves both the file and the active
pools unchanged. A resolved path that collides with the counter state file is
refused.

If a higher-priority source is set but unusable — for example malformed
`OMP_MODEL_POOLS_JSON` — routing still fails open and falls through, but pool
editing is disabled until that source is repaired, so an accepted edit can never
be written to a lower-priority file the operator did not intend to be
authoritative.

## Commands

The extension registers one user command, `/model-pool` (registered as
`model-pool`). With no argument it opens a menu: **Switch Current Model**,
**Edit Role Pools**, **Status**, **Doctor**, and **Help**. It also accepts the
arguments `pick`, `edit [role]`, `status`, `doctor`, and `help`; unknown
arguments print usage and change nothing.

`pick` switches the active model of the **main** session only. It requires an
interactive session, refuses while the session is busy, lists the authenticated
models (with a case-insensitive filter once the list is large), re-verifies
authenticated membership immediately before applying, and reports success only
after the host confirms the new active model. Selecting the current model is a
no-op. It never touches pools or counters and never switches a child session's
model.

`edit` opens the role-pool editor. It accepts an existing role or a new bare
role name (a single leading `@` is stripped) and offers **Add Model**,
**Remove Entry**, **Move Earlier**, **Move Later**, **Delete Pool**, and
**Back**. Each accepted edit is saved as its own transaction when a file is
authoritative (see *Automatic saving*). Creating a pool for an unknown role
does not create or assign an OMP core role.

`status` reports the effective configuration source, whether edits are writable
or runtime-only, the main role and rotation toggle, pool order, the current
model, the persistence mode, and the resolved state path. `doctor` reports
per-entry resolve and authenticated-membership results, distinguishes an
unreadable registry from a readable empty one, and performs no writes.

## Behavior

- `before_subagent_spawn` (primary): strips one leading `@` from
  `event.modelRole` → `roleKey`. No pool → return nothing. No `modelRole`
  (explicit per-dispatch pin, not via role) → return nothing and log the skip.
  Each pool entry is validated with `ctx.models.resolve` and must also appear
  in `ctx.models.list()`; failures filter out. Empty pool → fail open (leave
  the spawn unmodified, log) unless `strict` covers the role, in which case
  `{ block: true, reason }` refuses the spawn. Otherwise pick
  `pool[counter[roleKey]++ % pool.length]` and return
  `{ model: picked, note: "pool slow[i/n]: picked" }`. The note surfaces in
  the task UI; `{ roleKey, agent, invocationKind, picked, index }` goes to
  `pi.logger`. Last returned `model` wins when several extensions handle the
  event — this extension only claims pools it configures.
- `session_start` (secondary): `before_subagent_spawn` never fires for the
  main session, so main-session rotation is a `session_start` handler gated on
  `ctx.agent?.kind === "main"` (checked via `kind`, never `depth`: `/tan`
  clones are subs at depth 0). It rotates a **genuinely new** session only.
  `session_start` also fires for a loaded session, and overriding a restored
  model mid-conversation would invalidate prompt caches, so two signals both
  mean "loaded": the session header predates this process
  (`ctx.sessionManager.getHeader().timestamp`), or the entries already hold a
  user or assistant message. The header is the decisive one because it is the
  only thing that separates a resume from a new session: `/new` and
  `omp --session <path>` both materialize a transcript immediately for a session
  that is genuinely new, so a transcript existing proves nothing, while a path
  that cannot be statted would look absent and clobber a resume. Entries alone
  are not enough either: a new session legitimately carries `session_init`,
  title/mode/model and usage records, and another extension's `session_start`
  handler may already have appended its own with `pi.appendEntry`. An unknown
  answer also skips rather than guessing.
  Otherwise: same
  resolve → pick → advance against `mainSessionRole` (default `"default"`),
  then apply it: resolve the selector to a `Model` with
  `ctx.models.resolve()`, await `pi.setModel(model)`, and only notify once the
  host confirms it now reports that model. A refusal (`false`), an unresolvable
  selector, or a host that keeps a different model logs a warning and leaves the
  model alone — none of them is reported as a rotation. Disabled with
  `enableMainSessionRotation: false`.
  The cursor step is committed **only after the host accepts** the model
  (see "Counter semantics"), so a main session whose model could not be
  applied does not burn a slot; the next startup retries the same one. A host
  that accepts but cannot report its active model consumes the slot and emits
  the unconfirmed-model warning rather than pretending the rotation completed.
  An explicit effort suffix on the chosen entry is applied after the model is
  accepted: `model: ["provider/model:high@upstream"]` or
  `["provider/model@upstream:high"]` sets the thinking level through the host's
  public setter, which clamps to the selected model's ladder. A comma-separated
  slot uses the first alternative that both resolves and matches the applied
  model; a literal id that already ends in the level, a selector with no
  suffix, or an explicit `:auto` (not selectable through the public setter)
  leaves the level alone with a warning. Manual `/model-pool pick` changes only
  the model, and subagents still receive the exact configured selector.
- Handler errors fail open (log, return nothing) unless `strict` applies.
- `strict` hard-blocks only when the model registry actually answered and none
  of the pool's entries are authenticated. An unreadable registry (no
  `ctx.models`, or a throwing `list()`) is a transient failure and always fails
  open, never a refusal.
- Authenticated membership is required, not just resolution: an entry that
  resolves but is absent from `ctx.models.list()` is unavailable, including
  when the list is readable but empty. A missing or throwing registry still
  fails open.
- Host compatibility: routing hooks are registered before optional command
  registration, so a host without command registration keeps rotating pools and
  gets a compatibility warning instead of failing. Commands that mutate state
  require an interactive main session; non-interactive contexts never open
  dialogs or mutate configuration.
- A spawn returns the **whole rotation**, not one model: the picked slot first,
  then the rest of the eligible pool in cursor order (wrapping, duplicates
  folded, unavailable entries dropped). `before_subagent_spawn` treats a
  returned list as the child's attempt order, so a provider error on the chosen
  model retries the next pool entry instead of the same one. The counter still
  advances exactly once per child, because the event fires once per spawn. A
  pool with a single usable entry returns a bare string.
- Core fallback is preserved: the returned list keeps role identity, so
  `retry.fallbackChains` / prewalk / advisor semantics still apply on top of the
  pool chain. `retry.enabled` and `retry.modelFallback` decide whether the host
  retries at all; with retries off, the chain is accepted but never used. If the
  requirement ever becomes "model must never change mid-instance", verify
  `retry.fallbackChains` + prewalk handoff behavior first — that is a separate
  follow-up, not this extension.
- There is no cap on pool size: the cursor is an index modulo the pool length and
  every entry is preserved. Practical limits come from the host — each spawn
  offers the pool as its retry chain, so a very large pool buys longer failover
  at the cost of each retry attempt.

## Counter semantics

- Strict in-order round-robin per role. Random / shuffle-bag is out.
- The cursor is an index into the **configured** pool, stored modulo its
  length, so it stays bounded. An entry that is temporarily unauthenticated is
  skipped without re-phasing the rotation, and a pool with nothing eligible
  consumes no cursor step. Modding a filtered list instead re-phases the cycle
  whenever availability changes, which emits a duplicate pick at the swap.
- Module-level `Record<string, number>`, shared in-process across every
  session this OMP binds. Parallel spawns advance in handler-execution order
  (nondeterministic under concurrency).
- By default the counters are **in-memory only**: separate OMP processes never
  share, and restarting OMP resets the cycle. Set `persistCounters: true` to
  continue one cycle across sequential `omp` processes (each launch is a fresh
  OS process), which is the usual case for `omp -p`.
- With `persistCounters: true` the pick becomes a read-modify-write against
  `stateFile` (`~/.omp/agent/model-pool-state.json` by default),
  serialized by an atomic-directory lock so parallel processes on the **same
  machine and filesystem** never draw the same slot. The lock is not
  distributed: state is not shared across machines, and a network filesystem
  with weak attribute caching weakens the staleness check.
- The lock is never broken on a timeout. It records its owner's pid, and is
  reclaimed only when that process is provably gone (or when an ownerless lock
  — a crash between `mkdir` and the ownership stamp — is older than two
  minutes). Reclaiming claims the lock by atomic rename and re-verifies the
  owner, so a live-but-slow holder cannot lose its lock; release is
  token-guarded, so a holder whose lock was reclaimed never deletes its
  successor's.
- Every failure is fail-open: a bad read/write logs and falls back to the
  in-memory counter, and a state file that is malformed or carries an unknown
  `version` is left untouched for the operator to repair or delete rather than
  silently reset.
- A main-session pick is committed **after** the host accepts it. Selection and
  the host call happen under the same lock, so the durable cursor and the live
  session cannot disagree: a refusal, an unresolvable or unauthenticated
  selector, a host without `setModel`, or a host that reports a different model
  consumes nothing and leaves the state file byte-identical. If the host
  accepts but the write then fails, the model is **not** applied again; the
  process mirrors the accepted index in memory, reports the pick as
  `persisted: false`, and logs that rotation continues from the local cursor
  only. A read/lock failure before acceptance falls back to the in-memory
  cursor and says so (that fallback is not serialized across processes) rather
  than claiming a durable pick.
- Replacing the state file retries only a transient Windows sharing violation
  (`EPERM`/`EBUSY` from the final rename) after 10/20/40/80 ms, with one temp
  file and no unlink of the destination; the writer stays synchronous, so no
  other process can observe a half-applied edit. Other errors are fatal and the
  temp file is removed. Lock-reclaim renames never retry.
- The state file is written as `version: 2`. A `version: 1` file — written by
  the earlier release, which also used a different extension name — is
  **replaced, not reinterpreted**: v1 stored an unbounded running count that
  was reduced modulo the *filtered* list of authenticated entries, while v2
  stores an index into the *configured* pool, so the same integer means a
  different slot and no translation is sound. Rotation restarts from a fresh
  cursor, the old bytes are **copied** to `<stateFile>.v1.bak` (the live file is
  not moved away before the new one replaces it, and a failed copy is reported
  instead of hidden) so nothing is destroyed, and persistence keeps working.
  Only a schema we positively identified is superseded this way; a file we
  cannot recognize at all is left alone, as above.
- Revived / resumed children do not advance (the event fires once per new
  child, never on revive/resume).
- New main sessions share the same counters when roles overlap;
  e.g. a `@default` subagent pool and main-session `default` rotation draw
  from one counter.
- Editing a pool never advances or resets a cursor. Duplicate entries are
  preserved as distinct configured slots, and removing the last entry deletes
  the role's pool (restoring core passthrough) after confirmation.

## Validate

1. `omp --extension ./omp-model-pool`; check `/extensions`.
2. Pool of 2–3 authenticated models on `slow`; dispatch the same agent
   (`reviewer` → `@slow`) 4+ times; task rows show rotating model + note.
3. Dispatch different agents sharing `@slow`; the shared counter advances.
4. Dispatch on an unconfigured role; behavior unchanged.
5. Dispatch with an explicit model pin; the pool does not override.
6. Revive/resume a parked child; no counter advance.
7. Restart OMP; counters reset (or, with `persistCounters: true`, continue from
   the state file).
8. Open 3+ fresh main sessions; the `default` pool (when configured) advances
   per session; `@slow` subagent cycling is unaffected except for shared
   counters when roles overlap.
9. With `persistCounters: true`, run two sequential `omp` processes against a
   `slow` pool of 2; the second process continues where the first stopped.
10. Resume a session (`omp -r`); the restored main-session model is not
    overridden. Start a brand-new session with the `default` pool configured;
    it rotates.
11. Make one entry of a 3-model pool unavailable (logout / remove its key);
    the cycle skips it without repeating the entry before it.
12. Run under a named profile (`omp --profile work`) with `persistCounters:
    true`; state lands under `.omp/profiles/work/agent/`, and a second profile
    keeps its own cycle rather than sharing the default profile's cursor.
13. Open `/model-pool`; with no argument the menu appears. `help`, `status`,
    and `doctor` run without changing pools, counters, or files; an unknown
    argument prints usage and changes nothing.
14. `pick` on an idle main session: filter and select a listed model and confirm
    the host reports it as active. Cancelling, selecting the current model, and
    running `pick` in a busy or non-interactive session change nothing.
15. `edit`: add, reorder, and remove an entry; each accepted edit is saved
    immediately when a file is authoritative, the next spawn uses the edited
    pool, and the cursor did not move. Remove the last entry of a role and
    confirm the pool is deleted and core passthrough restored.
16. First-run: with no config file, opening the editor or running `status`
    creates nothing; the first confirmed edit creates
    `<OMP agent dir>/model-pool.json` in the nested shape. With
    `OMP_MODEL_POOLS_JSON` set, edits are labelled runtime-only and the inline
    source is never rewritten.

Unit coverage (`npm test`): same-agent wrap, cross-agent shared counter,
`@`-prefix key equivalence, unconfigured-role and explicit-pin passthrough,
unauthenticated filtering with fail-open vs `strict` block, stable phase across
an availability change, restart reset, main-session advance with sub exclusion
and a session-header load signal (metadata-only resumed session, session created
by this process, unreadable header, unparseable timestamp), the real-host apply
contract (a resolved `Model` is passed, and a refusal or a wrong active model is
never logged as a rotation), profile- and `PI_CONFIG_DIR`-aware state paths, and
opt-in persistence (cross-process continuation, abandoned-lock reclaim, a live
holder's lock never stolen, a 4-process × 5-pick contention run,
disabled-is-in-memory-only, schema- and malformed-state fail-open, version-1
replacement, non-boolean opt-in ignored, flat-config opt-in, and in-process
serialization).

The acceptance gate is covered directly: refusal, a throwing `setModel`, an
identity mismatch, a missing setter, an unauthenticated entry and a throwing
`list()` all leave the state file byte-identical and the next startup retries
the same slot; a setter that completes without confirmable `current()` consumes
exactly one. A gated `setModel` proves a queued same-role spawn takes the slot
after the accepted startup pick (or the same slot after a refusal) while a
different role is unaffected. A durable-write failure after acceptance mutates
the session once, mirrors the cursor in memory and preserves the live state
bytes. Effort coverage pins the setter call order and every accepted spelling
(`:high`, `:max`, `:low`, unique prefixes, `@alias:high`, `id:high@upstream`,
`id@upstream:high`) and the cases that must set nothing (losing comma
alternative, literal level suffix, absent suffix, refusal, mismatch, `:auto`).
Windows atomic replacement is fault-injected to prove one commit from the same
temp file after a transient sharing violation, and that exhaustion removes the
temp without unlinking the live file. Doctor is pinned to a single
authenticated snapshot per invocation, and the editor's navigation is pinned so
deleting the last entry returns to the role picker.

## End-to-end test against a real OMP (offline)

```bash
npm run test:e2e
```

Deterministic and offline: a Node loopback server implements OpenAI-style
`/v1/chat/completions` for a generated `agentDir/models.yml` provider, and a
real installed OMP (v19.2.1 or a newer compatible CLI) runs against it. No
credentials and no network leave the process — the fixture is the only
inference endpoint, and proxy variables point away from the internet.

Every assertion is taken from the host's own record, never the extension's log:

- a fresh session rotates a `[B, A]` pool, asserting the assistant turn ran on
  `B` with `reasoning_effort: "high"`, then on `A` with no effort, and that the
  durable cursor reads `1` then `0`;
- an exact `--resume` of the second transcript adds one turn on `A` and leaves
  the cursor at `0`;
- delegation through the real `task` tool produces one child transcript per
  spawn, located by `parentSession`, so `slow-a:high` → `slow-b` → `slow-a`
  proves in-process wraparound and that the counter is keyed by role, not by
  agent name;
- a pool whose only entry is unavailable leaves the spawn on its pinned model
  (fail open) without a wire request for the missing entry;
- three successive `mistral models refresh` runs against the fixture prove live
  discovery: a new roster appears, a retired id disappears, and a malformed
  response keeps the previous catalog.

An absent binary, a timeout, a CLI error, a malformed transcript or a model
mismatch fails the suite. CI pins the published `omp-linux-x64` v19.2.1 asset
and verifies its SHA-256 before use.

## Live gateway smoke test (optional)

```bash
npm run test:live
```

The only check that talks to a real provider. It is deliberately narrow and
free-only:

- routes must be marked free by the provider's own catalog (`isFree` for Kilo)
  *and* carry all-zero monetary fields. Live catalogs return prices as strings
  (`"0"`), so zero is accepted as a number or a numeric string; `"-1"`, blank,
  boolean and null pricing are unknown, never free. IDs must be concrete
  `owner/model:free` entries — routing aliases and upstream pins are rejected;
- credentials come from `KILO_API_KEY` / `OPENROUTER_API_KEY` /
  `MISTRAL_API_KEY` when exported, otherwise from the same Doppler secrets OMP
  itself uses (`doppler secrets get KILO_GATEWAY_API --project ai-automation
  --config dev --plain`). A key is never printed, never written to disk and
  never placed in the sandbox environment;
- a test-only loopback relay admits only the allowlisted chat path and exact
  model id, forwards only `messages`, `model`, `stream` and a bounded
  `max_tokens` with the real bearer, and never retries; the sandbox knows only
  the verified free rows, so no fallback can reach a paid model;
- two fresh processes rotate `[B, A]` with the start pinned outside the pool,
  asserting the assistant turn's recorded model and the durable cursor (`1`
  then `0`), then an exact `--resume` must not re-rotate;
- Mistral is checked independently: `fetchMistralLiveModels` is called against
  the official catalog and must return a non-empty chat roster with positive
  limits.

A provider failure may skip a turn only when the relay observed the matching
admitted request, and a skip is reported as a skip — never as a pass. Missing
credentials, unavailable catalogs or fewer than three verified free routes skip
with the reason. Anything else that goes wrong fails.

`OMP_LIVE_ROUTES=a,b,c` pins the trio (pin, B, A); each is still verified, and a
malformed or proven-unfree selection fails instead of silently choosing
another route.

## API (tests / hosts)

```ts
import pool, { configurePools, resetCounters, getCounters, getPools, resolveStateFilePath } from "./src/index.ts";
configurePools({ pools: { slow: ["p/a", "p/b"] }, strict: false, persistCounters: false });
resetCounters(); // mirrors an OMP restart (in-memory counters only)
```

`configurePools` is a deliberate replacement of the active configuration and
outranks every file source. Options passed to the factory and
`OMP_MODEL_POOLS_JSON` are runtime-only: they are never written back, and UI
edits made against them are labelled runtime-only.
