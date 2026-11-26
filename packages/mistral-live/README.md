# omp-mistral-live

Authoritative live model discovery for [oh-my-pi](https://github.com/can1357/oh-my-pi).

Mistral ships a `GET /v1/models` catalog. Without this extension OMP treats its
bundled Mistral list as the catalog, so retired ids keep being offered and fail
at runtime with `HTTP 400 invalid_model`. This extension registers Mistral with
`fetchDynamicModels` and reports the live chat roster
(`capabilities.completion_chat === true`) as authoritative.

- **No hardcoded model ids.** Newly released chat models appear on refresh;
  retired ones disappear.
- **Your credential is preserved.** The existing OMP Mistral credential is used;
  `apiKey` is never overridden.
- **Fail-safe.** Network, auth or schema failures throw, so OMP keeps its last
  cached catalog instead of emptying Mistral models. A schema error is a
  discovery failure, not "Mistral has no models".

## Install

```bash
omp install packages/mistral-live
# or for a dev checkout
omp --extension ./packages/mistral-live/src/mistral-live.ts
```

## Controls

| Variable | Effect |
|---|---|
| `OMP_MISTRAL_LIVE_BASE_URL` | Point discovery at a Mistral-compatible endpoint |
| `OMP_MISTRAL_LIVE_DISABLE=1` | Disable discovery without uninstalling |

## Test

```bash
npm run build && node --test packages/mistral-live/test/*.test.mjs
```

The offline checks cover payload shape, embedded/non-chat filtering, cache
semantics and the timeout fallback. The real catalog is exercised optionally by
`npm run test:live` from the repo root.
