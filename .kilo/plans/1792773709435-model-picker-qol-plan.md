# Model Picker, Pool Editing, and Verification Plan

## Outcome and Authorization

Implement an OMP extension command that both switches the active main-session model and edits role-based round-robin pools. Include bounded diagnostics and test-harness improvements, commit all task changes, open a PR, and explicitly request code review. This document is the authoritative handoff; this planning session changes no source code and creates no commit or PR.

User decisions on 2026-10-23:

- **Decided:** include both an active-session model picker and a role-pool editor.
- **Decided:** automatically save each accepted pool edit when a file is authoritative. Higher-priority programmatic/inline configuration remains runtime-only, clearly labeled.
- **Decided:** discover a profile-scoped `<agent dir>/model-pool.json` below existing configuration sources; create it only on the first confirmed pool edit.
- **Proposed implementation defaults:** use native OMP dialogs, no added production dependency; do not change round-robin policy, reset counters, generate model turns, or modify OMP's own role/settings files through the picker.

Finish line: both interactive flows work through a real OMP host; deterministic tests and CI pass; all intended changes are committed and pushed in one feature branch; a PR exists with an explicit review request. If real-host execution or reviewer access is unavailable, report that specific missing evidence rather than claiming completion.

## Grounding and Feasibility

Repository inspected at `main`, commit `d154171`; initial worktree clean. Remote is `MooseGooseConsulting/omp-model-pool`, default branch `main`. GitHub CLI authentication and repository ADMIN permission were verified. Recheck these at execution time; never include authentication output or tokens in artifacts.

| Boundary | Evidence | Feasibility and consequence |
| --- | --- | --- |
| Pool engine | `src/index.ts:158-193`, `682-774`, `901-953` | Extend existing configuration/eligibility/cursor logic; do not introduce a second router. |
| Main-session application | `src/index.ts:983-1017` | Resolve to a Model, await `pi.setModel`, verify the reported current identity. Switching does not require a provider request. |
| Configuration | `src/index.ts:547-625`, factory at `1032-1052` | Existing precedence is options > inline JSON > explicit file > empty. Add provenance, diagnostics, and default-file discovery without changing established explicit-file resolution. |
| Profile resolution | `src/index.ts:206-279` | Reuse `agentDir()` for the new default config. Preserve named-profile isolation and existing explicit state-path behavior. XDG remains an explicitly documented limitation. |
| Tests | `test/pool.test.mjs`, `test/cross-process.test.mjs`, `test/helpers/`, `test/live/` | Existing fake-host and real-process tests are reusable; new deterministic command tests are feasible without credentials/network. |
| Delivery | `package.json:14-18`; no CI workflow in checkout | Add CI running the existing build/test contract plus new tests. Existing history uses `feat:`, `fix:`, `test:` commit subjects. |

Authoritative host API evidence: `can1357/oh-my-pi` revision `0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0`, `packages/coding-agent/src/extensibility/extensions/types.ts`:

- `pi.registerCommand(name, { description?, getArgumentCompletions?, handler(args, ctx) })` registers a user-initiated command.
- `ctx.ui.select(title, options, dialogOptions?) -> Promise<string | undefined>` accepts strings or `{ label, description? }` and returns the selected **label**, not an arbitrary ID.
- `ctx.ui.input(...) -> Promise<string | undefined>` and `ctx.ui.confirm(...) -> Promise<boolean>` support basic editing without mounting the host's internal ModelPicker.
- `ctx.hasUI`, `ctx.mode`, and `ctx.isIdle()` belong to the context, not `ctx.ui`; command context additionally provides `waitForIdle()`.
- `ctx.models.list()` is the authenticated model list; `resolve(selector)` resolves aliases/selectors; `current()` reports the active model. Resolution alone is not authentication proof.
- `pi.setModel(model: Model) -> Promise<boolean>` accepts a resolved object, not a selector string.

Source URL: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/extensibility/extensions/types.ts

Three independent read-only subagents reviewed feasibility, harness gaps, and QoL. Their candidate findings require reproduction before being treated as bugs. In particular, the initial claim that interactive selection was unavailable was corrected against upstream types. No baseline tests or live model calls were run during planning; build/test commands write output and are deferred to execution. The installed OMP version and local runtime compatibility remain to be verified.

## Interaction and Behavior Contract

Register one namespaced `/model-pool` command (`registerCommand("model-pool", ...)`, without a leading slash in the registration name), not a conflicting `/model` replacement. No arguments opens a menu with **Switch Current Model**, **Edit Role Pools**, **Status**, **Doctor**, and **Help**. Also accept `pick`, `edit [role]`, `status`, `doctor`, and `help` arguments. Unknown arguments show usage and do not mutate anything. No arbitrary shell evaluation or LLM-callable mutation tool.

### Active Main-Session Picker

1. Require a known main agent, interactive UI capability, and idle session. Refuse a busy session with an actionable warning rather than aborting, queuing an unexpected switch, or switching mid-stream. Check again immediately before application after any dialog awaits.
2. Read the authenticated registry afresh. Display canonical `provider/id` identities, indicate current selection, and offer a case-insensitive text filter for large registries. Treat an empty list as no choices; a throwing registry is unavailable, not an empty authenticated set.
3. Selecting a different model is explicit consent to switch this conversation, including a resumed session. Explain that changing models can affect prompt caching. Do not silently select on open, cancellation, timeout, or filter input alone.
4. Re-resolve and verify authenticated membership immediately before applying; await `pi.setModel(resolved)`, then compare `ctx.models.current()` by canonical identity. False, throws, missing/unreadable current, and mismatched current must not produce a success notification. If the host changed but confirmation is unavailable, report an unconfirmed outcome, not a guaranteed rollback.
5. Selecting the current model is a no-op. Manual switching changes neither pools nor counters nor main-session rotation settings. Automatic rotation still happens only on future genuinely new sessions under existing rules. Never change a child session's model using this command.

### Role-Pool Editor

1. Choose an existing role or create a normalized bare role using the existing single-leading-`@` normalization. Show the effective source, save destination/runtime-only warning, configured order, availability, and counter policy before editing. Creating a pool for an unknown role does not create or assign an OMP core role; explain this.
2. Offer **Add Model**, **Remove Entry**, **Move Earlier**, **Move Later**, **Delete Pool**, and **Back**. Add chooses from the current authenticated registry, with filtering; store canonical selectors for new entries. Preserve existing selector spelling and unavailable entries until explicitly edited.
3. Treat existing duplicate entries as meaningful configured positions; do not silently deduplicate or reorder them. Label entries with their slot number so returned select labels are unique. Selecting the same canonical model for a new entry is allowed and clearly described as another slot.
4. Each accepted mutation is its own transaction and auto-saves. Back/Escape cancels only the current uncommitted action; previously saved actions remain saved. Confirm deletion or removal of the last entry. Removing the last entry deletes the role's pool, restoring core passthrough, including when strict covers that role; warn about that consequence before confirmation. Never write an empty pool that normalization would silently drop.
5. Capture the current configuration revision before awaiting input, then recheck before committing. Reject stale edits and refresh rather than overwriting another command's changes. New entries are revalidated before commit. Existing unavailable entries can still be removed/reordered.
6. Do not advance or reset a role cursor while editing. Preserve the existing numeric configured-slot cursor, reduced modulo current length by the next draw. Explain that changing pool order intentionally changes which model a slot represents. Ongoing spawns keep their captured pool; only subsequent spawns see the replacement.
7. Keep runtime edits alive across OMP factory rebindings to child sessions. The factory currently calls `configurePools` each time; introduce only the necessary module-scoped source/revision tracking so an unchanged source does not overwrite runtime edits. Explicit public `configurePools()` remains an intentional replacement and existing tests must continue to work. A changed backing source invalidates an open editor draft. No global watch service is required.

### Automatic Saving and Source Safety

- Precedence becomes options > valid inline JSON > valid explicit file > profile default file > empty. Preserve the current fall-through behavior on malformed explicit sources for routing, but emit source-specific warnings. If any higher-priority configured source is unreadable/malformed, disable editing/saving until repaired, so the picker cannot write to a surprising fallback destination.
- Track source kind, resolved path, original raw document, and a source fingerprint. Never print inline JSON, credentials, or raw arbitrary configuration values in diagnostics.
- For valid options/inline sources, label edits **runtime-only** before confirmation. Never rewrite environment variables, the caller's options object, or a shadowed file. Retain runtime changes for the same effective source across session bindings.
- For file sources, preserve unrelated top-level keys and unedited selectors. Preserve flat versus nested shape when editing an existing supported file. Use nested shape for a newly created default file. A flat-config role name colliding with option keys cannot be represented safely: reject creating it with a clear error rather than silently converting unrelated data.
- Keep existing `OMP_MODEL_POOL_CONFIG` CWD-relative semantics (`src/index.ts:618`) and support profile default discovery through `agentDir()`. README wording currently conflates config/state relative paths; correct it rather than silently relocating existing explicit files. Do not add new `~` semantics to explicit config paths in this slice.
- A missing explicitly configured file may be created at that explicit path on the first confirmed edit; other read failures and malformed documents are not equivalent to missing. Default discovery never writes just because the extension loads, `status` runs, or a dialog opens.
- Serialize writes using the existing atomic-directory lock discipline on the config path, separate from the state path. Re-read/fingerprint after acquiring the lock; changed contents or unexpected creation cause a conflict warning and refresh, not last-writer-wins. Existing arbitrary external editors do not honor the lock; document that a race after the final fingerprint check cannot be fully prevented.
- Save a complete validated document through an exclusive temporary file and atomic rename; clean up temporary files on failure, create new files privately, and preserve an existing file's restrictive mode where the platform supports it. Publish the new active in-memory configuration only after successful file commit. Save failure leaves the active pools unchanged and shows an actionable error; no invisible runtime fallback for file-backed edits.
- Do not reuse the state serializer, which writes `{ version, counters }`. Reuse the lock mechanism and only extract a small generic atomic-write helper if both paths actually benefit. Do not touch a configured path that aliases the state/lock file; detect obvious resolved-path collisions and reject the edit.
- No counter schema migration. Config saves do not write or reset state. Other already-running OMP processes keep their loaded pool configuration until restart/rebind; automatic cross-process hot reload is outside scope. Shared numeric cursors across differing pool revisions retain this existing limitation.

## Bounded QoL Scope

- `status`: effective source and writable/runtime-only/conflicted status, main role and automatic-rotation toggle, pool order, current model, persistence mode, resolved state path. Clearly label in-memory counters as process-local mirrors, not authoritative persisted state.
- `doctor`: fresh per-entry resolve/authenticated-membership results, unreadable registry distinguished from a readable empty list, and safe config/state readability diagnostics. Read state without creating directories, acquiring a write lock, migrating v1, fixing files, or advancing counters. A live persisted cursor read is a point-in-time observation, not a reservation of the next model.
- Config warnings: distinguish parse, read, wrong-shape, and dropped invalid-entry problems, with source path/name and remediation. Do not log raw inline input. Preserve fail-open routing behavior.
- Use safe notification/log wrappers so broken UI/loggers never break spawn hooks. Register routing hooks independently of optional command setup, so a missing or throwing command registrar cannot disable rotation. Hosts without command registration retain routing hooks and get a clear compatibility warning. Mutation commands require UI and known main identity; noninteractive contexts do not open dialogs or mutate.
- Verify the authentication edge case in `filterAvailable` (`src/index.ts:707-711`): a readable empty list currently allows a resolved selector, contrary to the documented membership contract. Add a reproducer and enforce canonical authenticated membership consistently in routing, picker, and doctor. Preserve missing/throwing-registry fail-open and strict behavior. Do not infer authentication from resolution alone.

Excluded: counter reset/next/skip commands, scheduler changes, random/weighted algorithms, credential management, model price estimation, OMP core role assignment, automatic live CI credentials, custom TUI components, global keybindings, broad source decomposition, and unrelated legacy-backup/lock redesign. Revisit these only for a demonstrated blocker.

## Implementation Slices

1. **Baseline and contract check.** In an implementation-capable session, inspect status/diff/log, install from the lockfile if needed, run `npm run typecheck` and `npm test`, and record the actual runtime and OMP version. Verify target OMP provides the pinned API contracts. Create branch `feat/model-picker-qol` without switching away from unrelated user work. Stop for a baseline regression or unsupported contract that blocks the stated behavior.
2. **Config/eligibility foundation with regressions.** Extend `src/index.ts` with source provenance/default discovery, edit transactions/rebinding semantics, safe config persistence, and the authenticated-membership fix. Add focused config/availability tests before command wiring. Keep existing exported helpers, state schema v2, resume checks, explicit-pin behavior, and lock invariants intact.
3. **Command vertical slice.** Extend local structural types for optional command registration, native dialogs, context mode/identity/idle checks. Register `/model-pool`; implement main picker and add/remove/reorder/delete flows using the shared registry/config logic. A small shared apply-and-confirm helper is justified because startup rotation and manual picking use the same host boundary; keep policy differences at callers. Startup still cannot rotate loaded sessions. Tighten success reporting when current-model confirmation is absent, with regression tests.
4. **Diagnostics and usability.** Implement status/doctor/help, useful parse/save/conflict messages, source and runtime-only labeling, filter/reset-filter choices, and consistent cancellation. Ensure status/doctor work safely in fake and noninteractive contexts via logger/notification output without hidden writes. Avoid adding a separate exported API unless tests or documented hosts actually need it.
5. **Harness and CI.** Add `test/helpers/fake-host.mjs` only to share command registration, scripted dialogs, registry and model-application behavior between new tests; migrate existing helpers only where it removes duplication necessary for the new tests. Add `test/commands.test.mjs`, `test/config.test.mjs`, and focused process-helper coverage. Add `.github/workflows/ci.yml` with read-only permissions and Ubuntu/Windows jobs on PRs and pushes to main: lockfile install, typecheck, and `npm test`. Select Node versions based on actual lockfile/toolchain engine support; do not assert an unverified historical runtime matrix. No provider calls or secret credentials in default CI.
6. **Real host and docs.** Extend safe host verification where feasible and perform the real interactive smoke below. Update `README.md` configuration precedence, first-run setup, commands, source-save rules, cursor/edit semantics, relative paths, noninteractive limits, and validation instructions; update `model-pool.example.json` only if the documented format/settings require it. Record exact commands/outcomes and skips; never call a skipped live scenario a pass.
7. **Review and delivery.** Execute the delivery checklist below after all implementation slices are integrated. Keep this plan synchronized only for evidence-based deviations; implementation notes may be appended to this plan rather than creating another documentation artifact.

## Verification Matrix

Run `npm run typecheck`, `npm test`, and `git diff --check` as release gates. `npm test` already builds before running `test/*.test.mjs`; new top-level tests must be discovered by that glob.

| Criterion | Deterministic evidence and expected failure behavior |
| --- | --- |
| Safe model switch | Script selection, assert resolved object passed to setModel, awaited success and canonical current match; current selection/cancel are no-ops. Refusal, throw, wrong/missing/throwing current, registry changes, unavailable selection, duplicate labels, busy-after-dialog, sub/unknown identity, and no UI cannot falsely succeed. Pools/counters unchanged. |
| Pool management | Create role; append entry; remove one duplicate slot; reorder; delete last entry with confirmation; normalize `@slow`; preserve unrelated roles/options/aliases. Assert next real spawn uses edited pool and cursor rules, but edits themselves consume no draw. Cancellation after a saved action retains that action. |
| Auto-save durability | Temp config files for nested/flat documents, missing explicit target, first default creation, existing options preservation, reload from disk, higher-priority runtime-only source, and profile isolation. Successful edit survives a fresh process; opening picker/status alone creates no file. |
| Save failure/conflict | Deterministically force write/rename/read/lock failure using narrow injection or a controlled filesystem obstacle, not chmod-only Windows assumptions. Assert original file and active pool unchanged, temporary cleanup, actionable output, no lost cooperating writer update, no overwrite of malformed input, and state-path collision refusal. |
| Config lifecycle | Source precedence/fall-through warnings, malformed higher source disables mutations, wrong shapes, relative explicit paths, default profile separation, stale open draft, and runtime edits surviving child factory rebind with unchanged source. Public configurePools still replaces config intentionally. |
| Eligibility/strict | Resolved-but-unlisted and readable-empty-list entries are unavailable; missing/throwing registry fails open; strict blocks only readable configured pools with zero authenticated entries. Doctor and picker agree with spawn behavior. |
| Diagnostics | Status/doctor leave counters and all fixture files byte-identical, create no state/lock/config artifacts, report disk versus local state truthfully, and survive failing notify/logger. No inline secret values printed. |
| Host compatibility | Missing or throwing command registration leaves both routing hooks registered and executable; compatibility warning logged, no dialogs opened or config writes attempted. Register hooks first, then isolate optional registrar failures in try/catch. |
| Existing contracts | Run all existing pool and cross-process tests, including explicit pin passthrough, shared role wrap, availability phase, persisted contention, loaded-session preservation, and Model-object application. |

Harness review candidates, only add after checking existing coverage: disabled main rotation; strict covering all roles; unconfigured main role; flat option keys; ownerless abandoned-lock recovery and live-lock timeout fail-open. Prioritize boundaries touched by this feature over broad test-count growth. Use deterministic subprocess barriers instead of random sleeps; do not slow the whole suite with repeated six-second timeouts just to boost coverage.

Real-host verification:

1. Verify a supported OMP executable without installing a global plugin or changing owner settings. Extend `test/live/` only through its existing isolated temp-root/owner-config-hash safeguards; inspect its existing process-launch and cleanup helpers before adding another runner.
2. Add a no-provider-turn host-contract smoke when feasible: load a tiny test extension in an isolated host, observe command registration, and exercise model application/current confirmation. Fail closed on any attempted provider request. Fake-host assertions are not proof of real host contracts.
3. Manual interactive smoke in an isolated profile/config: open `/model-pool`; filter/select a listed model; verify active host model; cancel; add/reorder/remove a pool entry; restart and verify saved order; check runtime-only labeling under inline source and busy/no-UI refusal. Verify the owner's config hashes unchanged. Selection and editing must require no completion call, even if the selected model is paid.
4. Run `npm run test:live` only if the existing free-route/catalog and isolation prerequisites are met. Do not loosen free-only protections, fake transcript success, make model-driven delegation a deterministic pass, or treat cleanup/isolation violations as success. Report its existing skip-prone role delegation and provider-latency limitations separately from local test results.

## Parallel Reviews and Delivery Checklist

During implementation, dispatch independent read-only subagents with disjoint review scopes after relevant slices exist:

- **Config/state safety:** automatic-save transaction boundaries, source precedence, stale writes, profile/rebind behavior, cursor invariants, and no unintended state writes.
- **Host/UI contract:** real OMP signatures, identity/idle guards, cancellation, current-model confirmation, large registries, unavailable models, duplicate selector labels, and no-provider-turn safety.
- **Harness adversary:** test independence, false-green assertions, actual command execution rather than log matching, cleanup isolation, and Windows/Linux determinism.

Integrate confirmed findings; rerun affected tests, then the full gate. Do not delegate overlapping file edits, broaden scope on a reviewer suggestion alone, or claim a review finished while its required background result is pending.

1. Inspect `git status`, complete `git diff`, and `git log --oneline -10`; compare against the intended files and review all new untracked files. Check for secrets, logs, temp state, live transcripts, and generated `dist/`/`node_modules/` artifacts. Preserve unrelated user changes.
2. Commit **all task changes**, not every unrelated worktree file. Stage explicit paths only. Suggested logical commits: `feat: add model picker and auto-saved role pool editing`; `test: cover picker flows and add cross-platform CI`; include relevant docs/plan updates in their logical commit. No empty commits, amend, force push, or hook bypass. Mutating Git operations require the implementation session's confirmation mechanism.
3. Re-run full verification on the final tree and ensure task changes are committed. Inspect upstream tracking, remote/base, all commits being published, and `git diff origin/main...HEAD` before PR creation. Do not commit directly on main or merge the PR.
4. Push the feature branch normally. Use `gh pr create --base main --head feat/model-picker-qol` with a concise title/body describing both pickers, auto-save/source behavior, tests, actual live evidence/skips, risks, and no counter migration. Follow any PR template present at execution; none was found during planning.
5. Request code review explicitly. Existing PR #9 documents the repository's CodeAnt integration and supported trigger: post `@codeant-ai: review` using `gh pr comment <number> --body "@codeant-ai: review"`. Confirm the comment exists; report whether a review actually arrives rather than equating a posted request with completion. If that integration is no longer active, inspect available reviewers/teams and request an eligible non-author reviewer through `gh pr edit --add-reviewer`; never fabricate a reviewer identity or self-request review.
6. Check `gh pr checks` and report CI status plus the PR URL, commit IDs, review-request evidence, and residual skips. If checks fail on task changes, fix in a new commit, rerun gates, push, and renew review when substantive fixes warrant it. Do not auto-merge or publish a package.

## Stop Conditions and Recovery

- Stop and report if required host commands/dialogs/model application are incompatible with the target version; do not quietly replace an interactive picker with a text-only command.
- Stop for pre-existing failing baseline checks, blocked GitHub push/PR permission, or inability to request any review; identify the blocker and completed evidence accurately.
- Stop before touching an unreadable/malformed authoritative config, a state/config path collision, or unrelated concurrent user edits that directly conflict with task files. Ordinary external config changes during editing yield a recoverable refresh, not destructive overwrite.
- If automatic persistence cannot be made safe on the supported filesystem, report that blocker instead of silently downgrading the user's automatic-save decision.
- No state migration is needed. A failed edit preserves the old active/file configuration. To roll back a successful rollout, revert the feature commits in a new commit/PR and restore edited pool configuration from an operator-owned backup if desired; reverting code alone does not undo intentional user configuration changes. Do not delete the state file or force-reset history.
- Real-host proof may remain blocked by host availability or provider prerequisites. Complete safe local work, report the exact missing scenario, and leave the PR's verification caveat explicit.

## Execution Evidence

Planning handoff review completed by a fourth read-only subagent. Its concrete compatibility-test gap was incorporated above; the remaining findings were already covered by the configuration, eligibility, and persistence contracts.

### Implementation

Baseline (branch `main`, `d154171`): `npm run typecheck` clean, `npm test` 52/52. Local runtime Node v24.20.0; installed host `omp v18.12.6`, matching the pinned upstream revision `0b5c27ab…` the API was verified against.

Delivered on branch `feat/model-picker-qol`:
- `src/index.ts`: config provenance + profile-scoped default file (`<agent dir>/model-pool.json`), auto-saved pool-edit transactions with atomic-directory lock, fingerprint re-check and atomic rename, authenticated-membership fix, `/model-pool` command (picker, editor, status, doctor, help), shared apply-and-confirm helper used by both startup rotation and the picker.
- `.github/workflows/ci.yml`: Ubuntu + Windows, Node 24, `npm ci` + typecheck + `npm test`, `contents: read`.
- `README.md`: precedence, first-run setup, automatic saving, commands, membership and host-compatibility behaviour.
- Tests: `test/helpers/fake-host.mjs`, `test/commands.test.mjs` (24), `test/config.test.mjs`, plus new cases in `test/pool.test.mjs` (disabled main rotation, boolean `strict`, flat-config option keys).

### Deviations

- Plan said: track the original raw document as part of source provenance.
  Code required: `savePoolEdit` re-reads the file under the lock, so the loaded document is stale by definition and would be dead state.
  Taken: dropped the unused `configRawDoc`; the freshest document (`current.value` under the lock) is the write base, with `configShape` deciding flat vs nested layout. Conservative: strictly fresher data.

- Plan said: disable editing when a higher-priority source is malformed.
  Code required: the first implementation only disabled editing for malformed *file* sources; malformed inline JSON fell through to a writable file source.
  Taken: added an explicit `blockedReason` so a malformed `OMP_MODEL_POOLS_JSON` keeps fail-open routing but marks the resolved source non-writable. Confirmed by the config/state-safety review.

- Reviewer flagged: duplicate select labels could mis-route the picker.
  Taken: `readAuthenticatedModels` now de-duplicates by canonical identity before listing. Low severity (a well-formed host returns unique identities) but cheap and correct.

### Parallel reviews

Four read-only subagents ran concurrently. Config/state-safety and host/UI-contract reviews returned **no confirmed defects**; the one plan-conformance gap above and the duplicate-label risk were the only actionable items. Reviewer notes that were deliberately not actioned, with reasons: extending the state/config collision check to whole-directory containment would reject the legitimate default case (both files live in the agent dir); and treating an absent `isIdle` as busy would break hosts that omit it, whereas the host contract guarantees it.

### Real-host verification (corrected)

An earlier pass reported this as blocked: a print-mode run in an isolated root had failed with `Devin stream error failed_precondition: Your weekly usage quota has been exhausted`. Generalising that single Devin-backed invocation into "no provider turn can succeed", and reporting the suite as blocked without running the suite that exists for exactly this purpose, was wrong.

Corrected evidence, run 2026-10-23 against the installed `omp v18.12.6`:

- The configured roles and pools use free routes only: `modelRoles.default` is `kilo/nvidia/nemotron-3.5-lightning:free:high`, and `<agent dir>/model-pool.json` rotates `kilo/nvidia/nemotron-3.5-lightning:free` and `kilo/xingchen-agi/xing4.0-29b-a4b:free` for `default`, `slow` and `task`.
- A direct check of the suite's free-route contract found **13** routes that are `isFree`, end in `:free`, price at zero and exist in OMP's registry at the time of the run.
- `npm run test:live` **passed**: free-route discovery (pinned start `kilo/liquid/lfm-2.5-2.6b:free`, pool rotating `kilo/xingchen-agi/xing4.0-29b-a4b:free` and `kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`); a first main run on `kilo/xingchen-agi/xing4.0-29b-a4b:free`; a second fresh OMP process on `kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` over the same state file, which is the rotation claim; and a resumed session keeping its restored model.
- Full suite tally: **8/8 checks passed**, including `owner configuration untouched — all hashes unchanged` and the counter check (`{"default":1,"slow":1}`). Two checks reported `skip`, and neither is a pass: the model-driven role-delegation check (`parent exited null; no delegation observed`, the suite's documented skip-prone case, since a free-tier parent does not reliably delegate), and `run root removed`, which skipped only because a root left behind by the earlier run I killed at its cap was still on disk for the harness's own sweep to collect.
- Not performed: the interactive TUI smoke — no headless path drives the picker/editor dialogs.

### Interactive flows driven on a real host (RPC + extension UI sub-protocol)

`omp --mode rpc` documents an extension UI sub-protocol (`extension_ui_request` / `extension_ui_response`), so the picker and editor were driven for real rather than left to a human. Results, against the installed host with a pinned free model and an isolated agent dir carrying the owner's provider config:

- the host lists the command as `name=model-pool source=extension`;
- `status` and `doctor` print real output (`registry readable, 635 authenticated model(s)`), and neither created `model-pool.json`;
- picker: the filter dialog was answered, a model was chosen from the host's real list, and after the switch the host's `get_state` reported the same provider and id;
- editor: it created `@slow`, added a model, and the profile file appeared as `{"pools":{"slow":[...]}}` with the write reported as a file write rather than runtime-only; `status` then re-read it as `default-file, writable`, and no state file was created.

Headless-spawn finding, superseded by the owner's interactive session on the same day: that spawn authenticated only Devin (`DEVIN_API_KEY` set, `KILO_API_KEY` unset), so `ctx.models.list()` held 635 models with no Kilo entry, `current()` was empty, `resolve()` failed for the configured Kilo free routes, and `doctor` reported them `unavailable — unresolved` while the main session stayed on the pinned model. It was the **spawn environment, not the mode**, that was unauthenticated.

The owner's real session reports `registry readable, 1429 authenticated model(s)` and every entry in `@default`, `@slow` and `@task` as `ok ... authenticated as kilo/...:free`, with `config: C:\Users\pmacl\.omp\model-pool.json (file-env, writable)` and `state: ...\agent\model-pool-state.json`. The pool is live and eligible there, automatic saves target that file, and counters persist across processes. Print mode rotates the same routes (the live suite above); the earlier RPC observation should be read as headless-spawn isolation, not as a defect.

### Review findings integrated

Automated review ran on PR #11 (CodeAnt, CodeRabbit, Kilo Code Review, Codex). Four Codex findings were confirmed real and fixed in a follow-up commit, each with a regression test:

1. **P1 — unchanged programmatic options discarded runtime edits.** Re-binding the factory for a child session re-applied the original options and wiped every runtime-only pool edit. Fixed with an `optionsSignature` guard mirroring the environment-source guard; `configurePools` now invalidates the signature so an explicit replacement still re-applies. Test `D23`.
2. **P2 — a malformed explicit config did not fall through for routing.** A malformed `OMP_MODEL_POOL_CONFIG` returned an empty configuration instead of using the lower-priority profile default file. Fixed: routing falls through to the next source while editing stays disabled. Test `A8`.
3. **P2 — deleting the final role changed a nested file's shape.** Dropping the empty `pools` key made the next load read the document as flat, so a later addition was written at the top level. Fixed by retaining the empty `pools` key; `C14` was rewritten to assert shape retention across a reload.
4. **P2 — an unconfirmed apply was reported as a completed rotation.** When the host never reported `current()`, success was claimed anyway. Fixed: `applyModelToSession` reports `confirmed`, and both the picker and startup rotation report an unconfirmed outcome instead of success. The null-current startup case was rewritten and a new picker case added.

Kilo Code Review's two suggestions were considered and declined, with reasons: the executed plan is deliberately kept as this PR's decision record, and splitting the README into `/docs` plus an `AGENTS.md` routing index is a documentation restructure outside this change's scope.

### Final outcome

- Branch `feat/model-picker-qol`: `7dd1761` (feat), `b9e90a2` (test + CI), plus this review-fix commit.
- Gate after the review fixes: `npm run typecheck` clean, `npm test` **109/109**, `git diff --check` clean.
- PR: https://github.com/MooseGooseConsulting/omp-model-pool/pull/11
- CI: `build-test (ubuntu-latest, 24)` pass, `build-test (windows-latest, 24)` pass; Graphite mergeability pass; Kilo Code Review pass; CodeAnt review completed; CodeRabbit still in progress.
- Review request: `@codeant-ai: review` comment posted (https://github.com/MooseGooseConsulting/omp-model-pool/pull/11#issuecomment-6370831867). The repository has exactly one collaborator (the author), so no human reviewer could be requested without fabricating an identity.
- Real-host evidence: `npm run test:live` passed **8/8 on free routes alone** (see the corrected section above). Residual gap: the interactive TUI smoke, plus the suite's two skips — model-driven role delegation and the leftover run-root sweep.

### Follow-up hardening (same branch)

The two interaction-contract items that the first pass left unsurfaced are now implemented, together with the follow-up hardening that landed in the same working tree:

- The role menu announces the configured order with per-entry membership, the counter policy, and the "editing never moves the cursor" guarantee once per role entry, instead of showing only an entry count. Entering a new role name explains that a pool routes only spawns asking for that role and does not create or assign an OMP core role. Two tests added.
- A fingerprint conflict now refreshes the active configuration and its source signature, so a deliberate retry after an external change works without reopening the editor; an unrelated read failure still refuses without reloading. `C18` gained revision assertions plus a new test.
- The picker names both models when the host keeps a different one: `requested X, but the session still reports Y`.
- CI pins `actions/checkout` and `actions/setup-node` to commit SHAs and sets `persist-credentials: false`.
- Gate after this batch: `npm test` **112/112**.
- Cross-repo install wiring (adjacent request): `coldaine-configurations` PR #138 adds `omp-plugins:apply` and `omp-plugins:check`, so an enrolled host installs this extension from a pinned revision instead of a developer checkout. The pin currently names this branch's head and moves to merged `main` after this PR lands.

### Second review round (local diff review + independent pass)

A local review of `d154171..HEAD` plus an independent five-pass subagent review over the committed diff agreed on four residual items; the first three are fixed here, the fourth is a cleanup:

1. **Confirmed — startup rotation emitted a success-styled toast on an unconfirmed apply.** The P2 fix above branched the *log* on `result.confirmed` but left the `ctx.ui.notify` toast unconditional, so a host that never confirmed `current()` still told the user the session rotated, contradicting the picker's warning path. Fixed: the toast is now emitted only when `result.confirmed`; the unconfirmed case sends a `warning`. This was a partial fix of item 4 above, not a new defect.
2. **Confirmed — the unconfirmed-rotation test pinned log text, not the user-visible claim.** `mainCtx` stubbed `ui.notify` as a no-op, so the toast defect above could not have been caught. Fixed: the harness records notifications, and the unconfirmed, refusal and success cases now assert the toast (or its absence).
3. **Confirmed mechanism — `configurePools` left stale file provenance.** It reset `loadedSignature` only, so after a file source was loaded, `editMode()` still returned `"file"` and a later `savePoolEdit` could merge the programmatic pools into that unrelated document. No in-repo caller; the embedding API was affected. Fixed: `configurePools` now mirrors the factory's options path (`configSource` = runtime-only options, `configShape` = `"none"`, `configFingerprint` = `undefined`). Test `D24`.
4. **Cleanup — `ctx.mode` was declared and faked but never read.** Interactivity is decided by `hasUI` plus dialog presence. Removed the dead field and the `mode: "tui"` stub.

CodeRabbit additionally requested that `status`/`doctor` distinguish a disabled source from a runtime-only one (both printed `runtime-only`, because they read `configSource.writable` alone). Fixed with a shared `sourceStatusLabel()` helper returning `writable` / `runtime-only` / `editing disabled`; test `A9`.

Gate after this batch: `npm run typecheck` clean, `npm test` **114/114**.

Merge state at the time of this record: PR #11 was `CHANGES_REQUESTED` (CodeRabbit). With the diagnostics fix above applied and pushed, the outstanding request is addressed; the PR clears when CodeRabbit re-reviews the new head.
