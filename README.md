# omp-musical-models

Musical chairs for models: every subagent spawn picks up the next model.

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
omp --extension ./omp-musical-models
# or
omp plugin link ./omp-musical-models
```

The manifest entry is `omp.extensions: ["./src/index.ts"]` in
`package.json`; no OMP fork is required. Distribute via npm or a
Git/marketplace entry.

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
  "strict": false                    // true | ["slow"] blocks empty-pool spawns
}
```

Flat shorthand (`{ "slow": [...] }`) is also accepted. Sources, in precedence
order:

1. Programmatic `options` passed to the factory (tests / hosts).
2. `OMP_MODEL_POOLS_JSON` — inline JSON (object with `pools` or flat map).
3. `OMP_MODEL_POOL_CONFIG` — path to a JSON file as above.

```bash
export OMP_MODEL_POOL_CONFIG=./model-pool.json
export OMP_MODEL_POOLS_JSON='{"slow":["anthropic/claude-haiku-4-5","openai/gpt-5-mini"]}'
omp --extension ./omp-musical-models
```

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
  clones are subs at depth 0). Same resolve → filter → pick → advance against
  `mainSessionRole` (default `"default"`), then `pi.setModel(picked)` plus a
  UI notify. Disabled with `enableMainSessionRotation: false`.
- Handler errors fail open (log, return nothing) unless `strict` applies.
- Core fallback is preserved: the returned single `model` keeps role identity
  so `retry.fallbackChains` / prewalk / advisor semantics still apply. If the
  requirement ever becomes "model must never change mid-instance", verify
  `retry.fallbackChains` + prewalk handoff behavior first — that is a separate
  follow-up, not this extension.

## Counter semantics

- Strict in-order round-robin per role. Random / shuffle-bag is out.
- Module-level `Record<string, number>`, shared in-process across every
  session this OMP binds. Parallel spawns advance in handler-execution order
  (nondeterministic under concurrency). Separate OMP processes never share.
- Revived / resumed children do not advance (the event fires once per new
  child, never on revive/resume). Restarting OMP resets counters.
- New main sessions share the same in-process counters when roles overlap;
  e.g. a `@default` subagent pool and main-session `default` rotation draw
  from one counter. Separate processes do not share.

## Validate

1. `omp --extension ./omp-musical-models`; check `/extensions`.
2. Pool of 2–3 authenticated models on `slow`; dispatch the same agent
   (`reviewer` → `@slow`) 4+ times; task rows show rotating model + note.
3. Dispatch different agents sharing `@slow`; the shared counter advances.
4. Dispatch on an unconfigured role; behavior unchanged.
5. Dispatch with an explicit model pin; the pool does not override.
6. Revive/resume a parked child; no counter advance.
7. Restart OMP; counters reset.
8. Open 3+ fresh main sessions; the `default` pool (when configured) advances
   per session; `@slow` subagent cycling is unaffected except for shared
   counters when roles overlap.

Unit coverage (`npm test`): same-agent wrap, cross-agent shared counter,
`@`-prefix key equivalence, unconfigured-role and explicit-pin passthrough,
unauthenticated filtering with fail-open vs `strict` block, restart reset,
main-session advance with sub exclusion.

## API (tests / hosts)

```ts
import pool, { configurePools, resetCounters, getCounters, getPools } from "./src/index.ts";
configurePools({ pools: { slow: ["p/a", "p/b"] }, strict: false });
resetCounters(); // mirrors an OMP restart
```
