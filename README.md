# omp-model-pool

Model pools you pick like models: select `pool/<name>` anywhere OMP takes a
model, and every new subagent or session on it starts on the next model in the
pool.

Standalone [oh-my-pi](https://github.com/can1357/oh-my-pi) extension. Each pool
in your config registers as a model, `pool/<name>`, so it shows up in `/model`
and in role settings next to every other model. Choosing it is the opt-in:

```yaml
# ~/.omp/agent/config.yml
modelRoles:
  task: pool/cheap-coders # task subagents rotate through the pool
  slow: anthropic/claude-opus-5-5:high # a real model: never rerouted
```

A role, `--model`, or an agent set to a real model is never touched, even when
a pool happens to share the role's name. Rotation never switches a running
conversation's model, so prompt caches survive: a subagent or a fresh session
picks its model once, before its first turn.

Authoritative event reference:
`can1357/oh-my-pi` main `docs/extensions.md`
(`before_subagent_spawn → { model, block, reason, note }`, `registerProvider`).

## Install

Dev / local link:

```bash
omp --extension ./omp-model-pool
# or
omp plugin link ./omp-model-pool
```

The manifest entry is `omp.extensions: ["./src/index.ts"]` in
`package.json`; no OMP fork is required. Distribute via npm or a
Git/marketplace entry.

## Configure

Pools are keyed by **name** and hold real model selectors in cycle order. A
name becomes the model id, so use letters, digits, `.`, `_` and `-` (a leading
`@` is stripped; anything else is skipped with a warning). A pool cannot
contain another pool.

```jsonc
// model-pool.json (see model-pool.example.json)
{
  "pools": {
    "cheap-coders": ["litellm/bloodarrow-deepseek", "isoquant/glm-5.3-flash"],
    "reviewers": ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"]
  },
  "strict": false,         // true | ["reviewers"] blocks spawns on an empty pool
  "persistCounters": false // true shares the cycle across OMP processes
}
```

Then select a pool where you want it: `/model` → `pool/cheap-coders`, a role in
settings (`modelRoles.task: pool/cheap-coders`), `--model pool/reviewers`, or
an agent's `model:`. A thinking suffix carries over to members that have none:
`pool/reviewers:high` runs `openai/gpt-5.2:high`.

`mainSessionRole` and `enableMainSessionRotation` are retired: a main session
rotates when its model is a pool (for example `modelRoles.default:
pool/reviewers`). If they are still in your file they are ignored with a
warning. Pools from an older config that are named after a role (`slow`,
`task`) no longer apply to that role by themselves; on the first main session
the extension names any such pool and the role setting that would select it.

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
export OMP_MODEL_POOLS_JSON='{"cheap":["litellm/bloodarrow-deepseek","isoquant/glm-5.3-flash"]}'
omp --extension ./omp-model-pool
```

### First-run setup

With no source configured the extension loads, reads nothing, and rotates
nothing. To give it a persistent home, either point `OMP_MODEL_POOL_CONFIG` at
a file, copy `model-pool.example.json` to `<OMP agent dir>/model-pool.json`, or
just open `/model-pool` and add a model to a pool: the first confirmed edit
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
**Edit Pools**, **Status**, **Doctor**, and **Help**. It also accepts the
arguments `pick`, `edit [pool]`, `status`, `doctor`, and `help`; unknown
arguments print usage and change nothing.

`pick` switches the active model of the **main** session only. It requires an
interactive session, refuses while the session is busy, lists the authenticated
models (with a case-insensitive filter once the list is large), re-verifies
authenticated membership immediately before applying, and reports success only
after the host confirms the new active model. Selecting the current model is a
no-op. It never touches pools or counters and never switches a child session's
model.

`edit` opens the pool editor. It accepts an existing pool or a new name and
offers **Add Model**, **Remove Entry**, **Move Earlier**, **Move Later**,
**Delete Pool**, and **Back**. Each accepted edit is saved as its own
transaction when a file is authoritative (see *Automatic saving*), and the
`pool/<name>` models are re-registered at once, so a new pool appears in
`/model` without a restart. Creating a pool assigns it nowhere; select it where
you want it.

`status` reports the effective configuration source, whether edits are writable
or runtime-only, the pools, the current model, the persistence mode, and the
resolved state path. `doctor` reports per-entry resolve and
authenticated-membership results, distinguishes an unreadable registry from a
readable empty one, and performs no writes. Every command re-reads the
configuration first, so it shows what is on disk.

## Behavior

- **Provider.** The factory registers provider `pool` with one model per pool
  (`pool/<name>`). Its context window and output limit are the smallest among
  the members that resolve (conservative defaults until a registry is seen), so
  a pool never advertises more than its weakest member takes. The registration
  is refreshed whenever the pools change.
- **Fresh config.** Every spawn, session start and command re-reads the
  configuration source first; an edit to the pool file applies to the very next
  pick. An unchanged source keeps runtime-only edits.
- `before_subagent_spawn`: looks only at the spawn's primary pattern. If it is
  `pool/<name>` (optionally `:<thinking>`), each pool entry is validated with
  `ctx.models.resolve` and must also appear in `ctx.models.list()`; failures
  are skipped. The handler picks the next eligible entry and returns
  `{ model: [picked, ...the pool's other eligible members, ...the spawn's own
  fallbacks], note: "pool/<name>[i/n]: picked" }`: the child starts on the pick
  and OMP's retry policy walks the rest if it fails, as separate attempts, never
  a switch inside one conversation. Any other spawn (a role alias, a real
  model, or a pool further down the fallback list) is returned untouched. An
  empty pool fails open (spawn unmodified, logged) unless `strict` covers it,
  in which case `{ block: true, reason }` refuses the spawn. The note shows in
  the task UI; pick details go to `pi.logger`.
- `session_start`: `before_subagent_spawn` never fires for the main session, so
  a main session whose model is `pool/<name>` is resolved here, gated on
  `ctx.agent?.kind === "main"` (checked via `kind`, never `depth`: `/tan`
  clones are subs at depth 0). It switches a **genuinely new** session only.
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
  Otherwise: pick from the pool, resolve the selector to a `Model` with
  `ctx.models.resolve()`, await `pi.setModel(model)`, and only notify once the
  host confirms it now reports that model. A refusal (`false`), an unresolvable
  selector, or a host that keeps a different model logs a warning and leaves the
  model alone — none of them is reported as a rotation.
- **Direct calls.** Anything that calls `pool/<name>` itself rather than through
  a spawn or a fresh session (commit messages, memory, a resumed session still
  on the pool) goes through the provider's own transport: it picks one member,
  pins it to that session id so later turns stay on it, fetches that member's
  credential from the host registry, and replays the request on it. A call
  without a session id takes the next member each time.
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
  gets a compatibility warning instead of failing. A host without
  `registerProvider` cannot show pools as models, so nothing routes, and the
  extension logs that once. Commands that mutate state require an interactive
  main session; non-interactive contexts never open dialogs or mutate
  configuration.

## Counter semantics

- Strict in-order round-robin per pool. Random / shuffle-bag is out.
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
- The state file is written as `version: 2`. A `version: 1` file — written by
  the earlier release, which also used a different extension name — is
  **replaced, not reinterpreted**: v1 stored an unbounded running count that
  was reduced modulo the *filtered* list of authenticated entries, while v2
  stores an index into the *configured* pool, so the same integer means a
  different slot and no translation is sound. Rotation restarts from a fresh
  cursor, the old file moves to `<stateFile>.v1.bak` so nothing is destroyed,
  and persistence keeps working. Only a schema we positively identified is
  superseded this way; a file we cannot recognize at all is left alone, as
  above.
- Revived / resumed children do not advance (the event fires once per new
  child, never on revive/resume).
- Every path that picks from a pool (spawns, fresh main sessions, direct calls)
  shares that pool's counter.
- Editing a pool never advances or resets a cursor. Duplicate entries are
  preserved as distinct configured slots, and removing the last entry deletes
  the pool after confirmation; anything still set to `pool/<name>` then stops
  resolving.

## Validate

1. `omp --extension ./omp-model-pool`; check `/extensions`, then `/model`:
   every configured pool is listed as `pool/<name>`.
2. Set `modelRoles.task: pool/<name>` with 2–3 authenticated models; dispatch
   `task` agents 4+ times; each child runs on the next model and the task rows
   show the note.
3. Keep a pool named `slow` while `modelRoles.slow` is a real model; a
   `reviewer` still runs on the real model.
4. Dispatch with an explicit model pin; the pool does not override.
5. Edit the pool file by hand, then dispatch once; that very spawn uses the
   edited pool.
6. Revive/resume a parked child; no counter advance.
7. Restart OMP; counters reset (or, with `persistCounters: true`, continue from
   the state file).
8. Start 3+ fresh main sessions with `--model pool/<name>` (or
   `modelRoles.default: pool/<name>`); each switches to the next member before
   its first turn.
9. With `persistCounters: true`, run two sequential `omp` processes against a
   pool of 2; the second process continues where the first stopped.
10. Resume a session (`omp -r`); the restored main-session model is not
    overridden.
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
15. `edit`: create a pool, add, reorder, and remove entries; each accepted edit
    is saved immediately when a file is authoritative, the new pool shows in
    `/model` at once, the next spawn uses the edited pool, and the cursor did
    not move.
16. First-run: with no config file, opening the editor or running `status`
    creates nothing; the first confirmed edit creates
    `<OMP agent dir>/model-pool.json` in the nested shape. With
    `OMP_MODEL_POOLS_JSON` set, edits are labelled runtime-only and the inline
    source is never rewritten.

Unit coverage (`npm test`): pool selection only through `pool/<name>` (a pool
named after a role does not reroute that role), rotation order and the
fallback list, thinking-suffix carry-over, shared counters, unauthenticated
filtering with fail-open vs `strict` block, stable phase across an
availability change, provider registration, edits applied on the next spawn,
retired-key warnings, main-session switching only for a fresh session on a
pool (session-header load signal: metadata-only resumed session, session
created by this process, unreadable header, unparseable timestamp), the
real-host apply contract (a resolved `Model` is passed, and a refusal or a
wrong active model is never logged as a rotation), profile- and
`PI_CONFIG_DIR`-aware state paths, and opt-in persistence (cross-process
continuation, abandoned-lock reclaim, a live holder's lock never stolen, a
4-process × 5-pick contention run, schema- and malformed-state fail-open,
version-1 replacement, non-boolean opt-in ignored, flat-config opt-in, and
in-process serialization).

## Live integration test (optional)

`npm test` is a fake host: it proves the pool logic, and it is why a wrong
`setModel` argument survived a green suite. The real host is covered separately
by an opt-in suite that runs an installed OMP:

```bash
npm run test:live
```

It proves main-session switching end to end: two fresh OMP *processes* start on
`--model pool/main` over a `[B, A]` pool and share one state file. `pool/main`
is not a real model, so each run has to switch to a member to pass, and the two
runs have to differ. The evidence is the `model`/`provider` OMP recorded on the
assistant turn, not the extension's log line — the log only reports what the
extension asked for, which is the claim under test.

Safety properties, since it spends real turns:

- routes must be marked free by the provider's own catalog (`isFree`) *and*
  present in OMP's registry. OMP's registry alone is not enough: it advertises
  `:free` ids the provider then rejects with 404, and reports `unknown` pricing
  for every zero-cost entry. `OMP_LIVE_ROUTES=a,b` pins the pair.
- everything lands under one temp root: its own `--session-dir`, cwd, config
  overlay and state file. The owner's config is hashed before and after and the
  run fails if any file changed. No plugin is installed.
- `--no-extensions -e <this repo>`, `--no-prewalk`, `--no-skills`, `--no-rules`,
  `--no-title`, plus an overlay disabling prewalk and the advisor, so nothing
  else runs and no paid role is reachable.
- anything unproven reports `skip` with the reason rather than passing.

It also proves the role path: the overlay sets `slow: pool/review`, and the
bundled `reviewer` agent declares `model: ["@slow"]`, so spawning it exercises
the same `before_subagent_spawn` path a normal delegation does. The trigger is
model-driven — OMP exposes no "spawn agent X" command — so a run where the
parent declines to delegate reports `skip` with that reason rather than passing.
The assertion is still not model-dependent: it reads the model on the child's
own assistant turn. At the end both counters are checked independently, so a
main-session pick cannot be mistaken for a spawn pick.

## API (tests / hosts)

```ts
import pool, { configurePools, parsePoolSelector, resetCounters, getCounters, getPools, resolveStateFilePath } from "./src/index.ts";
configurePools({ pools: { reviewers: ["p/a", "p/b"] }, strict: false, persistCounters: false });
parsePoolSelector("pool/reviewers:high"); // { name: "reviewers", thinking: ":high" }
resetCounters(); // mirrors an OMP restart (in-memory counters only)
```

`configurePools` is a deliberate replacement of the active configuration and
outranks every file source. Options passed to the factory and
`OMP_MODEL_POOLS_JSON` are runtime-only: they are never written back, and UI
edits made against them are labelled runtime-only.
