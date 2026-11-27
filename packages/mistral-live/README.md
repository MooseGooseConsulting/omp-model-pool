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
omp install ./packages/mistral-live
# or, from the package dir: `omp install .`
# or for a dev checkout
omp --extension ./packages/mistral-live/src/mistral-live.ts
```

## Controls

| Variable | Effect |
|---|---|
| `OMP_MISTRAL_LIVE_BASE_URL` | Replace the Mistral API base URL for **both** discovery and inference: `/v1/models` and every chat completion go to this host — it replaces the provider endpoint, not just the catalog source |
| `OMP_MISTRAL_LIVE_DISABLE=1` | Disable discovery without uninstalling |

`OMP_MISTRAL_LIVE_BASE_URL` overrides the endpoint OMP talks to, so inference
requests are sent there too. Point it at a Mistral-compatible gateway only when
that gateway serves both `/v1/models` and `/v1/chat/completions`; a catalog-only
mirror is not what it does.

## Running on the Mistral Vibe quota

Mistral's plans carry two separate monthly allowances — Vibe and API — and the
[subscription documentation](https://docs.mistral.ai/admin/billing-usage/subscriptions)
states that usage through non-Mistral products such as third-party coding
tools counts toward the **API** allowance. As of 2026-11 that split is not yet
enforced client-side: keys minted by the Vibe browser sign-in (`vibe --setup`)
bill against the Vibe allowance no matter which client sends them — verified
experimentally against `/v1/billing/budget`. Until enforcement begins, the
setup below routes OMP's Mistral traffic to the Vibe allowance; treat it as a
bridge, not a permanent arrangement, and watch `/v1/billing/budget` (or the
console) if you depend on it.

OMP does not read the Vibe keyring itself, but `models.yml` command-credentials
bridge it. Drop this resolver next to your config as
`~/.omp/agent/mistral-keyprint.py`:

```python
import os
from vibe.utils.api_keys import resolve_api_key
# An exported MISTRAL_API_KEY outranks the keyring in vibe's resolution order;
# force keyring resolution so a stray console key cannot silently win.
os.environ.pop("MISTRAL_API_KEY", None)
k = resolve_api_key("MISTRAL_API_KEY")
if k:
    print(k)
```

then point the mistral provider at it (tier 2 in the credential cascade, so it
outranks any stored `/login` credential — no need to delete old keys). Quote
both paths; user directories often contain spaces:

```yaml
providers:
  mistral:
    apiKey: "!\"<vibe-venv-python>\" \"<home>/.omp/agent/mistral-keyprint.py\""
```

with `<vibe-venv-python>` the Python of the uv tool environment that has
`mistral-vibe` installed (e.g.
`C:/Users/<you>/AppData/Roaming/uv/tools/mistral-vibe/Scripts/python.exe` on
Windows, `~/.local/share/uv/tools/mistral-vibe/bin/python` elsewhere).

Two lifecycle caveats. OMP caches a successful command output for the process
lifetime, so a `vibe` re-login only reaches sessions started (or explicitly
credential-refreshed) afterwards. And any OMP session already running keeps
the credential it resolved at startup — restart sessions to move them onto the
Vibe key. This extension composes as-is: discovery receives the same
command-resolved key through `fetchDynamicModels`.


## Test

```bash
npm run build && node --test packages/mistral-live/test/*.test.mjs
```

The offline checks cover payload shape, embedded/non-chat filtering, cache
semantics and the timeout fallback. The real catalog is exercised optionally by
`npm run test:live` from the repo root.
