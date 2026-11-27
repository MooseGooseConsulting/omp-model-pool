# omp-model-pool

Per-role round-robin model rotation for [oh-my-pi](https://github.com/can1357/oh-my-pi).

Every new subagent spawn resolving through a configured role takes the next
model in that role's pool instead of pinning one model; main-session rotation is
opt-in. The extension registers `before_subagent_spawn` and `session_start`
hooks plus a `/model-pool` command for picking, editing, and diagnosing pools.
It claims only roles it configures — every other spawn, pin, and role behaves
exactly as core OMP does.

## Install

```bash
omp install ./packages/model-pool
# or, from the package dir: `omp install .`
# or for a dev checkout
omp --extension ./packages/model-pool/src/index.ts
```

The package manifest lists `README.md`, `model-pool.example.json`, `src/` and
`dist/`; no OMP fork is required.

## Quick start

```jsonc
// <OMP agent dir>/model-pool.json (see model-pool.example.json)
{
  "pools": {
    "slow": ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"],
    "default": ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"]
  },
  "maxFallbacks": 1,                 // nonnegative safe integer: picked slot + N more eligible entries (0 = picked slot only); other values normalize to 1
  "mainSessionRole": "default",      // role rotated by session_start (bare name)
  "enableMainSessionRotation": true, // false keeps subagent cycling only
  "strict": false,                   // true | ["slow"] blocks empty-pool spawns
  "persistCounters": false           // true shares the cycle across OMP processes
}
```

Pools are keyed by **bare role name** (`slow`, `smol`, `default`, …) holding
selectors in cycle order. Unconfigured roles return nothing and core behavior
is unchanged; only roles you configure cycle. A leading `@` on a role
(`@slow`) is stripped once.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `pools` | `{}` | Role name → ordered selector array (the cycle order) |
| `maxFallbacks` | `1` | Nonnegative safe integer: eligible entries appended after the picked slot; `0` = picked slot only; any other value normalizes to `1` (see [Bounded failover](#bounded-failover-maxfallbacks)) |
| `mainSessionRole` | `"default"` | Bare role name rotated by `session_start` for main sessions |
| `enableMainSessionRotation` | `true` | `false` keeps subagent-only cycling |
| `strict` | `false` | `true` blocks every empty-pool spawn; an array blocks only the listed roles |
| `persistCounters` | `false` | `true` continues one cycle across sequential OMP processes via the state file |
| `stateFile` | `OMP_MODEL_POOL_STATE` or `~/.omp/agent/model-pool-state.json` | Counter file for `persistCounters` |

## Sources and precedence

1. Programmatic `options` passed to the factory (tests / hosts) — runtime-only.
2. `OMP_MODEL_POOLS_JSON` — inline JSON (object with `pools` or flat map) —
   runtime-only.
3. `OMP_MODEL_POOL_CONFIG` — path to an explicit JSON file as above.
4. `<OMP agent dir>/model-pool.json` — the profile-scoped default file.
5. Empty.

Sources 1 and 2 are **runtime-only**: they live in memory, are never rewritten,
and any pool edit made against them is labelled runtime-only and lost when the
process exits. Sources 3 and 4 are authoritative files, so accepted edits are
saved back to them automatically. The agent dir follows OMP's own resolution
(`~/<PI_CONFIG_DIR or .omp>`, `OMP_PROFILE` profiles, `PI_CODING_AGENT_DIR`); a
relative `stateFile` resolves against it, never the process CWD.

## How rotation works

- **Subagent spawns** (`before_subagent_spawn`, primary): the role key is the
  bare role name — agent names are logged, never used as the counter key, and
  an explicit per-dispatch model pin (not via a role) never consults a pool.
  Each pool entry is validated with `ctx.models.resolve` and must also appear
  in `ctx.models.list()`; failures filter out. An empty pool fails open (leaves
  the spawn unmodified, logs) unless `strict` covers the role, in which case
  the spawn is refused. Otherwise the spawn returns the bounded chain (below),
  and the counter advances exactly once per child — the event fires once per
  new child, never on revive/resume.
- **Main sessions** (`session_start`): fires for genuinely new sessions only —
  a loaded session (header predating this process, or user/assistant entries
  already present) is left alone so prompt caches survive. The pick is applied
  through the host setter and only reported as a rotation once the host
  confirms it.
- **Handler errors** fail open (log, return nothing) unless `strict` applies.

### Bounded failover (`maxFallbacks`)

The chain a spawn returns is the picked slot plus up to `maxFallbacks` further
eligible entries after it, in cursor order. Default `1`: one additional entry,
so a provider error on the picked model falls over exactly once more instead of
retrying the same model.

- `0` — only the picked slot is returned.
- any larger nonnegative safe integer — the picked slot plus that many more
  eligible entries, bounded by what the pool has available.
- any other value — negative, fractional, non-numeric, `NaN`, or beyond the
  safe-integer range — normalizes to the default `1`.

Exact chain semantics:

- Order follows the cursor: the picked slot is the cursor's current pick, and
  further entries are taken in configured order after it, wrapping.
- Exact duplicate selector strings are deduped; the first occurrence wins.
- Returned selectors are the raw configured strings, verbatim — never
  rewritten.
- Unavailable (unresolvable or unauthenticated) entries are skipped without
  re-phasing the rotation; they consume no cursor step.
- Host per-model retries (`retry.*` attempt counts) are separate: the returned
  chain only orders candidates, and the retry counts are the host's own policy,
  counted independently of the chain length.

Composition with the host's inherited chains:

- `maxFallbacks` caps the **returned pool slots**, not host attempts: the
  extension returns at most `1 + maxFallbacks` configured slots, and how many
  attempts each candidate receives is the host's own `retry.*` policy.
- OMP decides what those slots become only after expanding and resolving them
  (a comma-separated slot becomes several alternatives, aliases resolve to
  concrete models) and deduplicating the resulting candidates. When more than
  one candidate remains, OMP v19.2.1 installs them as the child's own
  failover chain and does **not** append the inherited
  `retry.fallbackChains`; when a single candidate remains, the inherited
  role/default `retry.fallbackChains` may still apply.
- So a comma-separated slot can expand into a child-specific chain even with
  `maxFallbacks: 0`, and a multi-slot return can collapse to a single
  candidate through aliases or dedupe: `maxFallbacks: 0` does not by itself
  preserve the inherited chain, and a multi-slot return does not by itself
  replace it. `retry.enabled` and `retry.modelFallback` still decide whether
  the host retries at all; with retries off, a returned chain is accepted but
  never used.

Config shape and the option name:

- In the nested shape (`pools` wrapper) `maxFallbacks` sits beside `pools`, so
  no role name can collide with it.
- In the flat shape a **scalar** `maxFallbacks` is the option; an
  **array-valued** `maxFallbacks` remains a legacy role pool — a role
  literally named `maxFallbacks` from the old flat role-map format — and does
  not configure the cap.
- The flat editor's reserved-key protection still applies: the editor refuses
  to create, edit, or delete a role named `maxFallbacks` (or any other
  top-level option key) in a flat file, so an accepted edit can never
  overwrite the option key or silently drop that legacy role.

Implications: every additional fallback is another host retry attempt — more
resilience against a single provider outage, but more latency before a turn
fails over, and later attempts run on different providers with their own cost
and latency. Cost grows with the chain only when an attempt actually fails; a
successful turn costs exactly one request. Switching providers mid-chain also
means the fallback inherits the new provider's context handling, not the failed
model's.

## Counter semantics

- Strict in-order round-robin per role. Random / shuffle-bag is out.
- The cursor is an index into the **configured** pool, stored modulo its
  length, so it stays bounded. An entry that is temporarily unauthenticated is
  skipped without re-phasing the rotation, and a pool with nothing eligible
  consumes no cursor step.
- Module-level `Record<string, number>`, shared in-process across every
  session this OMP binds. Parallel spawns advance in handler-execution order.
- By default the counters are **in-memory only**: separate OMP processes never
  share, and restarting OMP resets the cycle. `persistCounters: true` continues
  one cycle across sequential `omp` processes, serialized by an atomic-directory
  lock so parallel processes on the same machine never draw the same slot.
- Every persistence failure is fail-open: a bad read/write logs and falls back
  to the in-memory counter, and a malformed or unrecognized state file is left
  untouched for the operator to repair or delete rather than silently reset.
- A main-session pick is committed only after the host accepts the model: a
  refusal, an unresolvable or unauthenticated selector, a missing setter, or a
  host that reports a different model consumes nothing and leaves the state
  file byte-identical, so the next startup retries the same slot.
- Editing a pool never advances or resets a cursor. Duplicate entries are
  preserved as distinct configured slots, and removing the last entry deletes
  the role's pool (restoring core passthrough) after confirmation.

## Commands

The extension registers one user command, `/model-pool`. With no argument it
opens a menu: **Switch Current Model**, **Edit Role Pools**, **Status**,
**Doctor**, and **Help**. It also accepts the arguments `pick`, `edit [role]`,
`status`, `doctor`, and `help`; unknown arguments print usage and change
nothing.

`pick` switches the active model of the **main** session only. It requires an
interactive session, refuses while the session is busy, re-verifies
authenticated membership immediately before applying, and reports success only
after the host confirms the new active model. It never touches pools or
counters and never switches a child session's model.

`edit` opens the role-pool editor for an existing or new bare role name. Each
accepted edit is saved as its own transaction when a file is authoritative;
runtime-only sources are edited in memory only. Removing the last entry of a
role deletes the pool after confirmation.

`status` reports the effective configuration source, whether edits are
writable or runtime-only, the main role and rotation toggle, pool order, the
current model, the persistence mode, and the resolved state path. `doctor`
reports per-entry resolve and authenticated-membership results and performs no
writes.

## Controls

| Variable | Effect |
|---|---|
| `OMP_MODEL_POOL_CONFIG` | Path to an explicit JSON config file |
| `OMP_MODEL_POOLS_JSON` | Inline JSON config (runtime-only) |
| `OMP_MODEL_POOL_STATE` | Counter state file for `persistCounters` |

## Development

```bash
npm run build            # from the repo root (or: npm run build -w packages/model-pool)
npm run build && node --test packages/model-pool/test/*.test.mjs
```
