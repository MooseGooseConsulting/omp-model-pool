// Free-route verification for the optional internet smoke suite.
//
// Contract, in order of importance:
//   * credentials come only from the invoking environment's explicit vars
//     (KILO_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY); they are never
//     printed, never placed in the sandbox child environment, and never
//     written to disk;
//   * a route is serviced only when the provider's live catalog proves it
//     free: an explicit `:free` marker, a zero prompt/completion price (the
//     live APIs send prices as strings, so a numeric string equal to zero is
//     the passing shape), and a concrete `owner/model` shape (no routing alias
//     prefix, URL, whitespace, or upstream pin);
//   * nothing here ever picks a paid or "price unknown" fallback: an
//     unverifiable route is a skip, a proven-unfree or malformed explicit
//     route is a failure, and automatic selection below three candidates is
//     a skip.
/** 15 seconds: provider catalogs are cheap GETs; anything slower is unavailable. */
export const CATALOG_TIMEOUT_MS = 15_000;

/**
 * One entry per verifiably-free provider. `modelsUrl` is where the catalog was
 * fetched from and `chatUrl` where inference is forwarded; the relay imports
 * this map so "the same bases that served each catalog" is true by construct,
 * not by a copy that can drift.
 */
export const PROVIDERS = {
  kilo: {
    name: "kilo",
    envKey: "KILO_API_KEY",
    modelsUrl: "https://api.kilo.ai/api/gateway/models",
    chatUrl: "https://api.kilo.ai/api/gateway/chat/completions",
    // Kilo marks its free tier in the row itself; the `:free` id suffix in its
    // catalog is a convention of the upstream ids it proxies.
    requireIsFreeFlag: true,
  },
  openrouter: {
    name: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    requireIsFreeFlag: false,
  },
};

/** Derive the ordered provider list so selector parsing and iteration can never drift apart. */
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

function envCredentialName(kind) {
  return `${kind.toUpperCase()}_API_KEY`;
}

/**
 * The invoking environment's explicit override for `kind` (CI leg), trimmed, or "".
 * Callers never render the value.
 */
export function envProviderKey(env, kind) {
  const raw = env[envCredentialName(kind)];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Resolve the suite's credential for `kind` ("kilo" | "openrouter" | "mistral").
 *
 * The invoking environment's explicit var (`KILO_API_KEY` …) is the only
 * source. A missing or empty var yields `undefined`, which every consumer
 * reports as "no credential for <kind>" — a skip, never an error and never a
 * print.
 */
export async function resolveProviderCredential(kind, env = process.env) {
  const key = envProviderKey(env, kind);
  return key.length > 0 ? key : undefined;
}

/** Extra money-bearing pricing fields: when present, they must be zero too. */
const EXTRA_MONETARY_KEYS = [
  "request",
  "image",
  "web_search",
  "internal_reasoning",
  "input_cache_read",
  "input_cache_write",
];

/** Owner segments of the routing aliases both catalogs have carried ("forwards wherever it likes"). */
const ROUTING_ALIAS_OWNERS = new Set(["auto", "kilo-auto", "openrouter-auto", "reflection"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Classify one price field.
 *
 * The live gateways send prices as STRINGS (Kilo: {"prompt":"0",
 * "completion":"0","discount":0}; non-free rows use "-1"; null/booleans appear
 * on banners). Only a finite numeric zero — number or numeric string — is
 * "zero". Missing, blank, whitespace, boolean, null, unparseable, and negative
 * values are "unknown"/"nonzero", i.e. never free. `discount` is not a charge
 * and is not in the checked field list at all.
 */
export function priceStatus(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return "unknown";
  if (typeof value === "number") {
    return Number.isFinite(value) ? (value === 0 ? "zero" : "nonzero") : "unknown";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "unknown";
    const n = Number(trimmed);
    return Number.isFinite(n) ? (n === 0 ? "zero" : "nonzero") : "unknown";
  }
  return "unknown";
}

/**
 * Is this catalog id a concrete `<owner>/<model>:free` route?
 *
 * Required: the literal `:free` suffix (which alone excludes the routing
 * aliases we have seen — `kilo-auto/free`, `reflection/beam-free` — none carry
 * it), at least two `/`-separated segments, each segment alphanumeric plus
 * `._-` with no blank, "only dots", or trailing-dot segment, and no URL, `@`
 * pin, or whitespace anywhere.
 */
export function isConcreteFreeCatalogId(id) {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id !== id.trim() || /\s/.test(id)) return false;
  if (!id.endsWith(":free")) return false;
  const body = id.slice(0, -":free".length);
  if (body.length === 0) return false;
  // Directly reject URLs, upstream pins, and OMP-level selector markers so a
  // future catalog change cannot smuggle them past the segment rules below.
  if (/[:@#?]/.test(body)) return false;
  const segments = body.split("/");
  if (segments.length < 2) return false;
  // Known forward-anywhere routing aliases (none carry `:free` today; belt and
  // braces so a catalog change cannot quietly revive them).
  if (ROUTING_ALIAS_OWNERS.has(segments[0])) return false;
  return segments.every(
    (segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && !segment.endsWith("."),
  );
}

/**
 * Does one live-catalog row authorize a free turn?
 * Returns `{ free: true }` or `{ free: false, reason }`; reasons quote catalog
 * ids, which are public data — no credentials, headers, or error text.
 */
export function catalogEntryVerdict(entry, provider) {
  const providerConfig = PROVIDERS[provider];
  if (!isRecord(entry)) return { free: false, reason: "catalog row was not an object" };
  const id = entry.id;
  if (typeof id !== "string" || !isConcreteFreeCatalogId(id)) {
    return { free: false, reason: `${String(entry.id ?? "(no id)")} is not a concrete <owner>/<model>:free id` };
  }
  if (providerConfig !== undefined && providerConfig.requireIsFreeFlag && entry.isFree !== true) {
    return { free: false, reason: `${id}: the catalog does not mark it free (isFree !== true)` };
  }
  if (!isRecord(entry.pricing)) {
    return { free: false, reason: `${id}: the catalog row carries no pricing block` };
  }
  for (const key of ["prompt", "completion"]) {
    const status = priceStatus(entry.pricing[key]);
    if (status === "zero") continue;
    if (status === "unknown") {
      return { free: false, reason: `${id}: ${key} price is not a comparable number` };
    }
    return { free: false, reason: `${id}: ${key} price is nonzero` };
  }
  for (const key of EXTRA_MONETARY_KEYS) {
    if (entry.pricing[key] === undefined) continue;
    const status = priceStatus(entry.pricing[key]);
    if (status === "zero") continue;
    if (status === "unknown") {
      return { free: false, reason: `${id}: ${key} price is unknown (cannot prove the route is free)` };
    }
    return { free: false, reason: `${id}: ${key} price is nonzero` };
  }
  return { free: true };
}

/**
 * Parse one `OMP_LIVE_ROUTES` value — exactly three distinct selectors, in the
 * order pinned start, pool entry B, pool entry A. Invalid content fails; it
 * must never silently fall through to automatic selection.
 */
export function parseRouteSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0 || selector.trim() !== selector) {
    return { ok: false, reason: "selectors must be <provider>/<catalog-id> without whitespace" };
  }
  const slash = selector.indexOf("/");
  if (slash <= 0) {
    return { ok: false, reason: `${selector} is not <provider>/<catalog-id> (no provider prefix)` };
  }
  const provider = selector.slice(0, slash);
  if (!PROVIDER_NAMES.includes(provider)) {
    return {
      ok: false,
      reason: `${selector} uses provider "${provider}"; expected one of ${PROVIDER_NAMES.join(", ")}`,
    };
  }
  const catalogId = selector.slice(slash + 1);
  if (!isConcreteFreeCatalogId(catalogId)) {
    return { ok: false, reason: `${selector}: catalog id is not a concrete <owner>/<model>:free route` };
  }
  return { ok: true, route: { selector, provider, catalogId, entry: undefined } };
}

export function parseExplicitRoutes(raw) {
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length !== 3) {
    return {
      ok: false,
      reason: `OMP_LIVE_ROUTES must list exactly three selectors — pinned start, pool entry B, pool entry A — comma-separated (got ${parts.length})`,
    };
  }
  const routes = [];
  const seen = new Set();
  for (const part of parts) {
    const parsed = parseRouteSelector(part);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.route.selector)) {
      return { ok: false, reason: `OMP_LIVE_ROUTES lists ${parsed.route.selector} more than once` };
    }
    seen.add(parsed.route.selector);
    routes.push(parsed.route);
  }
  return { ok: true, routes };
}

/** Short, credential-free description of a failed request; never the error itself. */
function networkHint(err) {
  const name = err instanceof Error ? err.name : "";
  const code =
    err instanceof Error && typeof err.cause === "object" && err.cause !== null && typeof err.cause.code === "string"
      ? err.cause.code
      : "";
  if (name === "AbortError" || code === "UND_ERR_ABORTED" || /timed out/i.test(String(code))) return "timed out";
  if (/^E[A-Z0-9_]+$/.test(code)) return code;
  return "fetch failed";
}

/**
 * Fetch one provider's live catalog. Resolves `{ ok: true, rows }` or
 * `{ ok: false, reason }`; never throws, never includes credentials in a reason.
 */
async function fetchProviderCatalog(provider, { apiKey, timeoutMs = CATALOG_TIMEOUT_MS, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") return { ok: false, reason: "no fetch implementation" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("catalog request timed out")), timeoutMs);
  timer.unref?.();
  try {
    const headers = { accept: "application/json" };
    if (apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetchFn(PROVIDERS[provider].modelsUrl, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    const payload = await res.json();
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.data)) {
      return { ok: false, reason: "catalog payload was not a list" };
    }
    return { ok: true, rows: payload.data };
  } catch (err) {
    return { ok: false, reason: `catalog request failed (${networkHint(err)})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The pre-existing ranking, unchanged: smallest parameter bill first, non-
 * reasoning routes before reasoning ones, then larger context window, then
 * lexical. Reasoning free routes happily emit long chains of thought and free
 * tiers queue, so they are poor one-word-prompt candidates.
 */
export function rankFreeRoutes(routes) {
  const paramBillions = (catalogId) => {
    const m = catalogId.toLowerCase().match(/(\d+(?:\.\d+)?)b(?![0-9a-z])/);
    return m ? Number.parseFloat(m[1]) : Number.POSITIVE_INFINITY;
  };
  const isReasoning = (route) =>
    Array.isArray(route.entry?.supported_parameters) && route.entry.supported_parameters.includes("reasoning");
  return [...routes].sort((a, b) => {
    const pa = paramBillions(a.catalogId);
    const pb = paramBillions(b.catalogId);
    if (pa !== pb) return pa - pb;
    const ra = isReasoning(a) ? 1 : 0;
    const rb = isReasoning(b) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ca = typeof a.entry.context_length === "number" ? a.entry.context_length : 0;
    const cb = typeof b.entry.context_length === "number" ? b.entry.context_length : 0;
    if (cb !== ca) return cb - ca;
    return a.selector.localeCompare(b.selector);
  });
}

/**
 * Pick the smoke trio: `[pin, pool entry B, pool entry A]` (public selectors).
 *
 * With `OMP_LIVE_ROUTES` set it must be exactly three verified selectors;
 * malformed input fails, and a well-formed selection the provider could not
 * verify (no credential, unreachable catalog, id absent from a fetched
 * catalog) skips rather than picking another route. Without the override, both
 * cataloged providers are ranked together and the top three are taken;
 * anything less is a skip with concrete reasons.
 */
export async function selectRoutes(userEnv = process.env, { fetchImpl, timeoutMs } = {}) {
  const rawOverride = typeof userEnv.OMP_LIVE_ROUTES === "string" ? userEnv.OMP_LIVE_ROUTES : "";
  if (rawOverride.trim().length > 0) {
    const parsed = parseExplicitRoutes(rawOverride);
    if (!parsed.ok) return { status: "fail", routes: [], reason: parsed.reason };

    const providersNeeded = [...new Set(parsed.routes.map((route) => route.provider))];
    for (const provider of providersNeeded) {
      if (((await resolveProviderCredential(provider, userEnv)) ?? "").length === 0) {
        return {
          status: "skip",
          routes: [],
          reason: `cannot verify ${provider} route(s): no credential for ${provider}`,
        };
      }
    }
    const catalogs = new Map();
    for (const provider of providersNeeded) {
      const got = await fetchProviderCatalog(provider, {
        apiKey: (await resolveProviderCredential(provider, userEnv)) ?? "",
        fetchImpl,
        timeoutMs,
      });
      if (!got.ok) {
        return {
          status: "skip",
          routes: [],
          reason: `cannot verify explicit routes: ${provider} catalog unavailable (${got.reason})`,
        };
      }
      catalogs.set(provider, got.rows);
    }
    for (const route of parsed.routes) {
      const entry = catalogs.get(route.provider).find((row) => isRecord(row) && row.id === route.catalogId);
      if (entry === undefined) {
        return {
          status: "skip",
          routes: [],
          reason: `${route.selector}: absent from the live ${route.provider} catalog, so its freeness cannot be verified`,
        };
      }
      const verdict = catalogEntryVerdict(entry, route.provider);
      if (!verdict.free) return { status: "fail", routes: [], reason: `${route.selector}: ${verdict.reason}` };
    }
    return { status: "ok", routes: parsed.routes, reason: "OMP_LIVE_ROUTES override verified against the provider catalogs" };
  }

  const notes = [];
  const catalogs = new Map();
  for (const provider of PROVIDER_NAMES) {
    const apiKey = (await resolveProviderCredential(provider, userEnv)) ?? "";
    if (apiKey.length === 0) {
      notes.push(`${provider} skipped: no credential for ${provider}`);
      continue;
    }
    const got = await fetchProviderCatalog(provider, { apiKey, fetchImpl, timeoutMs });
    if (!got.ok) {
      notes.push(`${provider} unavailable: ${got.reason}`);
      continue;
    }
    catalogs.set(provider, got.rows);
  }
  if (catalogs.size === 0) {
    return { status: "skip", routes: [], reason: notes.join("; ") || "no provider credentials available" };
  }

  const candidates = [];
  const seen = new Set();
  for (const [provider, rows] of catalogs) {
    for (const entry of rows) {
      if (!isRecord(entry)) continue;
      const verdict = catalogEntryVerdict(entry, provider);
      if (!verdict.free) continue;
      const route = { selector: `${provider}/${entry.id}`, provider, catalogId: entry.id, entry };
      if (!seen.has(route.selector)) {
        seen.add(route.selector);
        candidates.push(route);
      }
    }
  }
  if (candidates.length < 3) {
    const detail = [...notes, `only ${candidates.length} verifiably free route(s) across the credentialed catalogs`];
    return { status: "skip", routes: [], reason: detail.filter(Boolean).join("; ") };
  }
  return { status: "ok", routes: rankFreeRoutes(candidates).slice(0, 3), reason: "" };
}

/**
 * What the durable cursor must read after one rotation run.
 *
 * The cursor follows the model the host actually accepted, and the host
 * records that as a `model_change` entry — which it writes *before* any
 * provider request. So:
 *
 * - a transcript with a `model_change` to the expected model means the slot
 *   was committed, even if the run then died before inference (no assistant
 *   turn at all);
 * - a transcript without one means nothing was accepted;
 * - no transcript means the question is unanswerable, and claiming either
 *   outcome would be a guess.
 */
export function cursorExpectation({ accepted, hadEvidence, previous, poolLength }) {
  if (!hadEvidence) {
    return {
      status: "skip",
      expected: previous,
      reason: "the run wrote no transcript, so the durable cursor cannot be judged",
    };
  }
  if (poolLength <= 0) {
    return { status: "skip", expected: previous, reason: "the pool is empty" };
  }
  return {
    status: "check",
    expected: accepted ? (previous + 1) % poolLength : previous,
    reason: accepted
      ? "the host recorded a model change, so the slot was committed"
      : "the host recorded no model change, so no slot was consumed",
  };
}

/**
 * Did any of these transcripts record the host accepting `expected`?
 *
 * Deliberately independent of assistant turns: a run can accept the model,
 * record the `model_change`, and die before inference. Callers must pass every
 * fresh transcript, not only the ones that produced an assistant message.
 */
export function acceptedEvidence(transcripts, expected) {
  return transcripts.some((entry) =>
    Array.isArray(entry?.modelsApplied) && entry.modelsApplied.includes(expected),
  );
}
