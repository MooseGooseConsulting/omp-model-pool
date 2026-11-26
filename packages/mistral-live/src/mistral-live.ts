// mistral-live — authoritative live model discovery for Mistral on oh-my-pi.
// See README.md ("Included extension: mistral-live") for behavior and env vars.

// ---------------------------------------------------------------------------
// Minimal structural types (kept local so the package stays zero-dependency).
// ---------------------------------------------------------------------------

export interface MistralModelCapabilities {
  completion_chat?: unknown;
  vision?: unknown;
  reasoning?: unknown;
  [key: string]: unknown;
}

export interface MistralApiModelRecord {
  id?: unknown;
  name?: unknown;
  aliases?: unknown;
  max_context_length?: unknown;
  capabilities?: unknown;
  [key: string]: unknown;
}

export interface ProviderModelThinkingConfig {
  mode: "effort";
  efforts: ("low" | "medium" | "high")[];
  defaultLevel: "low" | "medium" | "high";
}

export interface ProviderModelConfigLike {
  id: string;
  name: string;
  api: "openai-completions";
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinking?: ProviderModelThinkingConfig;
}

export interface ProviderRegistrationConfigLike {
  baseUrl: string;
  api: "openai-completions";
  fetchDynamicModels: (apiKey: string | undefined) => Promise<ProviderModelConfigLike[]>;
}

export interface MistralLiveExtensionApiLike {
  registerProvider?(name: string, config: ProviderRegistrationConfigLike): void;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  [key: string]: unknown;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

export interface MistralLiveOptions {
  /** Override base URL (defaults to `OMP_MISTRAL_LIVE_BASE_URL` or `https://api.mistral.ai/v1`). */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 10000). */
  timeoutMs?: number;
  /** Custom fetch implementation for tests. */
  fetch?: FetchLike;
  /** Environment override for tests. */
  env?: Readonly<Record<string, string | undefined>>;
}

export const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 32_768;
export const DEFAULT_TIMEOUT_MS = 10_000;

const MISTRAL_LARGE_4_THINKING: ProviderModelThinkingConfig = {
  mode: "effort",
  efforts: ["low", "medium", "high"],
  defaultLevel: "medium",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPositiveInteger(value: unknown, fallback: number): number {
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    num = Number(value.trim());
  } else {
    return fallback;
  }
  if (Number.isFinite(num) && num > 0) {
    return Math.floor(num);
  }
  return fallback;
}

function isDisabledFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}

/**
 * Validate and normalize a base URL, stripping trailing path slashes.
 * Requires `https:` except for loopback hosts (`localhost`, `127.0.0.1`, `::1`)
 * so the Mistral Bearer token is never transmitted in plaintext over a network.
 * Returns `undefined` if invalid.
 */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const serialized = parsed.toString();
  return parsed.pathname === "/" && !parsed.search ? serialized.replace(/\/+$/, "") : serialized;
}

/**
 * Build the `/models` endpoint URL from a normalized base URL without
 * corrupting query parameters (e.g. `?api-version=...`).
 */
export function buildModelsEndpointUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.hash = "";
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${cleanPath}/models`;
  return parsed.toString();
}

function isMistralLarge4Family(id: string, record: MistralApiModelRecord): boolean {
  const candidates: string[] = [id];
  if (typeof record.name === "string" && record.name.trim()) {
    candidates.push(record.name.trim());
  }
  if (Array.isArray(record.aliases)) {
    for (const alias of record.aliases) {
      if (typeof alias === "string" && alias.trim()) {
        candidates.push(alias.trim());
      }
    }
  }
  return candidates.some((c) => {
    const lower = c.toLowerCase();
    return lower === "mistral-large-4" || lower.startsWith("mistral-large-4-");
  });
}

/**
 * Map a single Mistral `/v1/models` record to an oh-my-pi provider model config.
 * Returns `null` for malformed rows or non-chat models (`capabilities.completion_chat !== true`).
 */
export function mapMistralApiModel(record: unknown): ProviderModelConfigLike | null {
  if (!isRecord(record)) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;

  const capabilities = isRecord(record.capabilities)
    ? (record.capabilities as MistralModelCapabilities)
    : undefined;

  // Match oh-my-pi's built-in rule: rows with a `capabilities` object must
  // explicitly advertise `completion_chat === true` (embeddings, OCR,
  // moderation, and audio-only SKUs reject `/chat/completions` with 400).
  // Rows without `capabilities` (compatible gateways) are kept.
  if (capabilities !== undefined && capabilities.completion_chat !== true) {
    return null;
  }

  const vision = capabilities?.vision === true;
  const reasoning = capabilities?.reasoning === true;
  const input: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];
  const contextWindow = toPositiveInteger(record.max_context_length, DEFAULT_CONTEXT_WINDOW);
  const rawName = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;

  const mapped: ProviderModelConfigLike = {
    id,
    name: rawName,
    api: "openai-completions",
    reasoning,
    input,
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
  };

  // Mistral Large 4 (including `mistral-large-latest` when it aliases Large 4)
  // only accepts low/medium/high reasoning effort; minimal/xhigh/max return 400.
  if (isMistralLarge4Family(id, record as MistralApiModelRecord)) {
    mapped.thinking = {
      mode: MISTRAL_LARGE_4_THINKING.mode,
      efforts: [...MISTRAL_LARGE_4_THINKING.efforts],
      defaultLevel: MISTRAL_LARGE_4_THINKING.defaultLevel,
    };
  }

  return mapped;
}

/**
 * Parse a Mistral `/v1/models` JSON payload into deduplicated chat models.
 * Throws if the payload does not contain a `data` array or contains malformed
 * model rows (not an object or missing a non-empty string `id`) so oh-my-pi's
 * cache fallback is preserved rather than publishing a corrupted/empty catalog.
 */
export function parseMistralModelsPayload(payload: unknown): ProviderModelConfigLike[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("mistral-live: unexpected /models response shape (missing data array)");
  }
  const seen = new Set<string>();
  const models: ProviderModelConfigLike[] = [];
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") {
      throw new Error("mistral-live: malformed model entry in /models response");
    }
    const mapped = mapMistralApiModel(item);
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    models.push(mapped);
  }
  return models;
}

/**
 * Fetch live chat models from Mistral's `/models` endpoint.
 * Throws on missing API key, non-2xx HTTP status, timeout, or malformed JSON so
 * oh-my-pi falls back to its cached catalog instead of emptying Mistral models.
 */
export async function fetchMistralLiveModels(
  apiKey: string | undefined,
  options: {
    baseUrl?: string;
    timeoutMs?: number;
    fetch?: FetchLike;
  } = {},
): Promise<ProviderModelConfigLike[]> {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) {
    throw new Error("mistral-live: missing Mistral API key");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl) ?? DEFAULT_MISTRAL_BASE_URL;
  const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const fetchFn: FetchLike =
    options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)!;

  if (typeof fetchFn !== "function") {
    throw new Error("mistral-live: global fetch is unavailable");
  }

  const endpoint = buildModelsEndpointUrl(baseUrl);
  let signal: AbortSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    signal = AbortSignal.timeout(timeoutMs);
  } else if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(new Error("mistral-live: request timed out")), timeoutMs);
    timer.unref?.();
  }

  const init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  } = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  };
  if (signal !== undefined) {
    init.signal = signal;
  }

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(endpoint, init);
    if (!response.ok) {
      throw new Error(`mistral-live: GET /models failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    return parseMistralModelsPayload(payload);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * oh-my-pi extension entrypoint.
 */
export default function mistralLiveExtension(
  pi: MistralLiveExtensionApiLike,
  options: MistralLiveOptions = {},
): void {
  const env = options.env ?? process.env;
  if (isDisabledFlag(env.OMP_MISTRAL_LIVE_DISABLE)) {
    pi.logger?.debug?.("mistral-live: disabled via OMP_MISTRAL_LIVE_DISABLE");
    return;
  }

  if (typeof pi?.registerProvider !== "function") {
    pi?.logger?.warn?.("mistral-live: host does not expose registerProvider; skipping registration");
    return;
  }

  const explicitUrl = options.baseUrl ?? env.OMP_MISTRAL_LIVE_BASE_URL;
  let baseUrl = DEFAULT_MISTRAL_BASE_URL;
  if (explicitUrl !== undefined && explicitUrl.trim() !== "") {
    const normalized = normalizeBaseUrl(explicitUrl);
    if (normalized) {
      baseUrl = normalized;
    } else {
      pi.logger?.warn?.(
        `mistral-live: ignoring invalid base URL; falling back to ${DEFAULT_MISTRAL_BASE_URL}`,
      );
    }
  }

  const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const fetchOpts: { baseUrl: string; timeoutMs: number; fetch?: FetchLike } = {
    baseUrl,
    timeoutMs,
  };
  if (options.fetch !== undefined) {
    fetchOpts.fetch = options.fetch;
  }

  pi.registerProvider("mistral", {
    baseUrl,
    api: "openai-completions",
    fetchDynamicModels: (apiKey) => fetchMistralLiveModels(apiKey, fetchOpts),
  });
}
