// Offline proof for the free-gateway relay and the free-route predicates.
//
// Runs under plain `node --test` (the `test` script globs
// `packages/*/test/*.test.mjs` and `test/**/*.test.mjs`) with NO network: the
// relay's outbound fetch is injected, so every assertion here is local (the
// only sockets are loopback). These tests guard the safety invariants of the
// optional live suite:
//   * money: live prices are numeric STRINGS — "0" authorizes, "0.000"
//     authorizes, "-1", blank, boolean, null, absent, and positive values do
//     not; a route only ever reaches the relay when its catalog proved free;
//   * shape: only concrete `owner/model:free` ids are routes at all;
//   * forwarding: an admitted request carries exactly the four smoke fields
//     (messages, model, stream, max_tokens) to the fixed provider base with
//     the real bearer and `redirect: "error"` — client fallback/router/tools
//     fields and the client's own headers never leave the relay;
//   * resilience: non-2xx upstream answers are verified once, never retried;
//     the 30s upstream deadline aborts; client disconnects cancel upstream.
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import {
  catalogEntryVerdict,
  isConcreteFreeCatalogId,
  parseExplicitRoutes,
  parseRouteSelector,
  priceStatus,
  PROVIDER_NAMES,
  PROVIDERS,
  rankFreeRoutes,
} from "./free-routes.mjs";
import {
  createFreeGateway,
  FORWARD_MAX_TOKENS,
  PROVIDER_CHAT_URLS,
  publicSelectorFromSmokeIdentity,
  renderSmokeProvidersYaml,
  toSmokeSelector,
} from "./free-gateway.mjs";

const REAL_KILO_KEY = "test-kilo-real-key";

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/** Injected upstream fetch that answers with a small SSE body and records its call. */
function sseUpstream(calls, { status = 200, contentType = "text/event-stream", chunks } = {}) {
  const list = chunks ?? ["data: hello\n\n", "data: [DONE]\n\n"];
  return async (input, init = {}) => {
    calls.push({ input, init });
    if (status !== 200) {
      return { ok: false, status, headers: { get: () => null }, body: null };
    }
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of list) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return { ok: true, status, headers: { get: (k) => (k === "content-type" ? contentType : null) }, body };
  };
}

/** Injected upstream fetch that never answers and rejects only when its signal aborts. */
function hangingUpstream(calls) {
  return (input, init = {}) => {
    calls.push({ input, init });
    const { signal } = init;
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };
}

/** Raw POST against the relay on loopback; resolves {status, contentType, text}. */
function postJson({ port, urlPath, bearer, body }) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "POST", headers },
      (res) => {
        let text = "";
        res.on("data", (d) => {
          text += d;
        });
        res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// free-routes: the zero-price gate
// ---------------------------------------------------------------------------

test("priceStatus accepts only finite numeric zero, string or number", () => {
  assert.equal(priceStatus(0), "zero");
  assert.equal(priceStatus(-0), "zero");
  assert.equal(priceStatus("0"), "zero");
  assert.equal(priceStatus("0.000"), "zero");
  assert.equal(priceStatus(undefined), "unknown");
  assert.equal(priceStatus(null), "unknown");
  assert.equal(priceStatus(true), "unknown");
  assert.equal(priceStatus(false), "unknown");
  assert.equal(priceStatus(""), "unknown");
  assert.equal(priceStatus("   "), "unknown");
  assert.equal(priceStatus("free"), "unknown");
  assert.equal(priceStatus(Number.NaN), "unknown");
  assert.equal(priceStatus(Number.POSITIVE_INFINITY), "unknown");
  assert.equal(priceStatus("-1"), "nonzero");
  assert.equal(priceStatus(0.0001), "nonzero");
  assert.equal(priceStatus("1e-9"), "nonzero");
});

test("catalog prices that are unavailable, unknown, or positive do not authorize a turn", () => {
  const id = "z-ai/glm-4.5-air:free";
  // Kilo rows normally carry `isFree: true`; the no-flag rows are built below
  // by overriding it to undefined.
  const entry = (pricing, extra = { isFree: true }) => ({ id, pricing, ...extra });

  // Missing / null / blank / boolean pricing is unknown → not free.
  assert.equal(catalogEntryVerdict({ id }, "kilo").free, false);
  assert.equal(catalogEntryVerdict({ id, pricing: null }, "kilo").free, false);
  assert.equal(catalogEntryVerdict(entry(undefined), "kilo").free, false);
  assert.equal(catalogEntryVerdict(entry({ prompt: "", completion: "0" }), "kilo").free, false);
  assert.equal(catalogEntryVerdict(entry({ prompt: null, completion: 0 }), "kilo").free, false);
  assert.equal(catalogEntryVerdict(entry({ prompt: true, completion: 0 }), "kilo").free, false);

  // Live shape: numeric-string zeros pass; negative strings ("−1") do not.
  assert.equal(catalogEntryVerdict(entry({ prompt: "0", completion: "0", discount: 0 }), "kilo").free, true);
  assert.equal(catalogEntryVerdict(entry({ prompt: 0, completion: 0 }), "kilo").free, true);
  const rejected = catalogEntryVerdict(entry({ prompt: "-1", completion: "-1" }), "kilo");
  assert.equal(rejected.free, false);
  assert.match(rejected.reason, /nonzero/);

  // Other monetary fields, when present, must be zero too; a discount field is
  // not a charge and is ignored.
  assert.equal(catalogEntryVerdict(entry({ prompt: "0", completion: "0", image: "0" }), "kilo").free, true);
  assert.equal(
    catalogEntryVerdict(entry({ prompt: 0, completion: 0, input_cache_read: "0.01" }), "kilo").free,
    false,
  );
  assert.equal(
    catalogEntryVerdict(entry({ prompt: 0, completion: 0, web_search: "unknown-currency" }), "kilo").free,
    false,
  );
  assert.equal(
    catalogEntryVerdict(entry({ prompt: 0, completion: 0, internal_reasoning: null }), "kilo").free,
    false,
  );
  assert.equal(
    catalogEntryVerdict(entry({ prompt: 0, completion: 0, input_cache_write: "0" }), "kilo").free,
    true,
  );

  // Kilo's row must carry `isFree === true`; openrouter only needs the price
  // proof plus the `:free` id.
  assert.equal(catalogEntryVerdict(entry({ prompt: "0", completion: "0" }, { isFree: false }), "kilo").free, false);
  assert.equal(catalogEntryVerdict(entry({ prompt: "0", completion: "0" }, { isFree: true }), "kilo").free, true);
  assert.equal(catalogEntryVerdict({ id, pricing: { prompt: "0", completion: "0" } }, "openrouter").free, true);

  // Reasons name the catalog id and field, never a credential.
  const reason = catalogEntryVerdict(entry({ prompt: 1, completion: 0 }), "kilo").reason;
  assert.match(reason, /z-ai\/glm-4\.5-air:free/);
  assert.match(reason, /prompt/);
});

test("concrete free ids: shape, :free marker, no alias or URL or pin", () => {
  assert.equal(isConcreteFreeCatalogId("z-ai/glm-4.5-air:free"), true);
  assert.equal(isConcreteFreeCatalogId("meta-llama/llama-3.3-70b-instruct:free"), true);
  assert.equal(isConcreteFreeCatalogId("inclusionai/ling-3.2-flash:free"), true);

  assert.equal(isConcreteFreeCatalogId("kilo-auto/free"), false); // routing alias, no :free
  assert.equal(isConcreteFreeCatalogId("reflection/beam-free"), false);
  assert.equal(isConcreteFreeCatalogId("kilo-auto/free:free"), false); // alias owner
  assert.equal(isConcreteFreeCatalogId("auto/anything:free"), false); // alias owner, belt and braces
  assert.equal(isConcreteFreeCatalogId("z-ai/glm-4.5-air"), false); // no :free suffix
  assert.equal(isConcreteFreeCatalogId("https://evil.example/a:free"), false);
  assert.equal(isConcreteFreeCatalogId("z-ai/glm@v1:free"), false); // upstream pin marker
  assert.equal(isConcreteFreeCatalogId("z-ai/glm 4:free"), false); // whitespace
  assert.equal(isConcreteFreeCatalogId(" z-ai/glm:free"), false);
  assert.equal(isConcreteFreeCatalogId(":free"), false);
  assert.equal(isConcreteFreeCatalogId("z-ai:free"), false);
  assert.equal(isConcreteFreeCatalogId("z-ai/.:free"), false);
  assert.equal(isConcreteFreeCatalogId(""), false);
  assert.equal(isConcreteFreeCatalogId(undefined), false);
  assert.equal(isConcreteFreeCatalogId(42), false);
});

test("explicit OMP_LIVE_ROUTES must be three distinct verified selectors", () => {
  const raw =
    "kilo/z-ai/glm-4.5-air:free,openrouter/meta-llama/llama-3.3-70b-instruct:free,kilo/deepseek/deepseek-r1:free";
  const parsed = parseExplicitRoutes(raw);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.routes.map((r) => r.selector), [
    "kilo/z-ai/glm-4.5-air:free",
    "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    "kilo/deepseek/deepseek-r1:free",
  ]);

  // Not three entries.
  assert.equal(parseExplicitRoutes("kilo/z-ai/glm-4.5-air:free,kilo/deepseek/deepseek-r1:free").ok, false);
  // Duplicate.
  assert.equal(
    parseExplicitRoutes("kilo/z-ai/glm-4.5-air:free,kilo/z-ai/glm-4.5-air:free,kilo/deepseek/deepseek-r1:free").ok,
    false,
  );
  // Unknown provider.
  assert.equal(
    parseExplicitRoutes("gpt/z-ai/glm-4.5-air:free,kilo/deepseek/deepseek-r1:free,kilo/x/a:free").ok,
    false,
  );
  // Whitespace inside a selector.
  assert.equal(
    parseExplicitRoutes("kilo/ not-free,kilo/deepseek/deepseek-r1:free,kilo/x/a:free").ok,
    false,
  );

  const single = parseRouteSelector("openrouter/meta-llama/llama-3.3-70b-instruct:free");
  assert.equal(single.ok, true);
  assert.equal(single.route.provider, "openrouter");
  assert.equal(parseRouteSelector("kilo-auto/free:free").ok, false);
  assert.equal(parseRouteSelector(" reflection/beam-free").ok, false);
  assert.equal(parseRouteSelector("mid-dash,comma:free").ok, false);
});

test("ranking keeps the pre-existing order across providers", () => {
  // paramBillions only matches digits immediately followed by "b" (so
  // "deepseek-r1" has no recognizable bill and sorts last), then nonreasoning
  // wins inside a parameter tie, then the larger context, then lexical.
  const route = (selector, context = 0, params = []) => ({
    selector,
    catalogId: selector.split("/").slice(1).join("/"),
    entry: { context_length: context, supported_parameters: params },
  });
  const tiny = route("kilo/tiny-model/1b:free", 32_768);
  const beta3b = route("openrouter/beta-3b:free", 4_000);
  const alpha3b = route("kilo/alpha-3b:free", 8_192, ["reasoning"]);
  const gamma4b = route("kilo/z-ai/gamma-4b:free", 196_608, ["reasoning"]);
  const glm4b = route("kilo/z-ai/glm-4b:free", 98_304, ["reasoning"]);
  const deepseek = route("openrouter/deepseek/deepseek-r1:free", 163_840);
  const ranked = rankFreeRoutes([glm4b, alpha3b, deepseek, tiny, beta3b, gamma4b]);
  assert.deepEqual(
    ranked.map((r) => r.selector),
    [
      "kilo/tiny-model/1b:free",
      "openrouter/beta-3b:free",
      "kilo/alpha-3b:free",
      "kilo/z-ai/gamma-4b:free",
      "kilo/z-ai/glm-4b:free",
      "openrouter/deepseek/deepseek-r1:free",
    ],
  );
  // "Same bases by construct": the relay forwards to the URLs the catalogs came from.
  assert.equal(PROVIDER_CHAT_URLS.kilo, PROVIDERS.kilo.chatUrl);
  assert.equal(PROVIDER_CHAT_URLS.openrouter, PROVIDERS.openrouter.chatUrl);
});

// ---------------------------------------------------------------------------
// relay: local admissions, forwarding shape, upstream handling
// ---------------------------------------------------------------------------

const SMOKE_MODEL = "z-ai/glm-4.5-air:free";
const SMOKE_SELECTORS = [
  { selector: "kilo/z-ai/glm-4.5-air:free", provider: "kilo", catalogId: SMOKE_MODEL },
];
const PROMPT = "Reply with exactly: OK";
const CHAT_BODY = {
  messages: [{ role: "user", content: PROMPT }],
  model: SMOKE_MODEL,
  stream: true,
  max_tokens: 8_000,
};

async function withGateway(options, run) {
  const gateway = await createFreeGateway(options);
  try {
    return await run(gateway);
  } finally {
    await gateway.close();
  }
}

test("local rejections never touch the upstream fetch", async () => {
  const calls = [];
  await withGateway(
    {
      routes: SMOKE_SELECTORS,
      providerKeys: { kilo: REAL_KILO_KEY },
      fetchImpl: sseUpstream(calls),
    },
    async (gateway) => {
      const wrongBearer = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        bearer: "wrong-bearer",
        body: CHAT_BODY,
      });
      assert.equal(wrongBearer.status, 401);

      const absentBearer = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        body: CHAT_BODY,
      });
      assert.equal(absentBearer.status, 401);

      const badPath = await postJson({ port: gateway.port, urlPath: "/v1/chat/completions", bearer: gateway.bearer, body: CHAT_BODY });
      assert.equal(badPath.status, 404);

      const nonChatPath = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/embeddings",
        bearer: gateway.bearer,
        body: CHAT_BODY,
      });
      assert.equal(nonChatPath.status, 404);

      const malformed = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        bearer: gateway.bearer,
        body: "{not json",
      });
      assert.equal(malformed.status, 400);

      const unlistedModel = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        bearer: gateway.bearer,
        body: { ...CHAT_BODY, model: "some/paid-model:free" },
      });
      assert.equal(unlistedModel.status, 403);

      const unknownProvider = await postJson({
        port: gateway.port,
        urlPath: "/mistral/v1/chat/completions",
        bearer: gateway.bearer,
        body: CHAT_BODY,
      });
      assert.equal(unknownProvider.status, 404);

      const notChat = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        bearer: gateway.bearer,
        body: { model: SMOKE_MODEL },
      });
      assert.equal(notChat.status, 400);

      assert.equal(calls.length, 0, "no upstream call may be triggered by a rejected request");
      assert.equal(gateway.snapshot().admitted, 0);
    },
  );
});

test("admitted requests forward exactly four fields to the fixed provider base", async () => {
  const calls = [];
  await withGateway(
    { routes: SMOKE_SELECTORS, providerKeys: { kilo: REAL_KILO_KEY }, fetchImpl: sseUpstream(calls) },
    async (gateway) => {
      const clientBody = {
        ...CHAT_BODY,
        stream: false,
        temperature: 0.7,
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
        tool_choice: "auto",
        router: "fallback:paid-model",
        fallbacks: ["paid/model"],
        models: ["paid/model"],
        provider: { order: ["paid"] },
        max_completion_tokens: 4096,
        stream_options: { include_usage: true },
      };
      const response = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        bearer: gateway.bearer,
        body: clientBody,
      });
      assert.equal(response.status, 200);
      assert.equal(response.contentType, "text/event-stream");

      assert.equal(calls.length, 1, "exactly one upstream connection per admitted request");
      const [call] = calls;
      assert.equal(call.input, PROVIDERS.kilo.chatUrl); // same base that served the catalog
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.redirect, "error");
      assert.deepEqual(Object.keys(call.init.headers).sort(), ["accept", "authorization", "content-type"]);
      assert.equal(call.init.headers.authorization, `Bearer ${REAL_KILO_KEY}`);

      const forwarded = JSON.parse(call.init.body);
      assert.deepEqual(Object.keys(forwarded).sort(), ["max_tokens", "messages", "model", "stream"]);
      assert.equal(forwarded.model, SMOKE_MODEL); // the exact verified id
      assert.equal(forwarded.stream, true);
      assert.equal(forwarded.max_tokens, FORWARD_MAX_TOKENS);
      assert.deepEqual(forwarded.messages, [{ role: "user", content: PROMPT }]);

      // SSE bytes and content type reached the client untouched.
      assert.equal(response.text, "data: hello\n\ndata: [DONE]\n\n");
    },
  );
});

test("a non-2xx upstream answer is passed through and never retried", async () => {
  const calls = [];
  await withGateway(
    { routes: SMOKE_SELECTORS, providerKeys: { kilo: REAL_KILO_KEY }, fetchImpl: sseUpstream(calls, { status: 429 }) },
    async (gateway) => {
      const response = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        bearer: gateway.bearer,
        body: CHAT_BODY,
      });
      assert.equal(response.status, 429);
      assert.equal(calls.length, 1, "no retry after an upstream rejection");
      const snapshot = gateway.snapshot();
      assert.equal(snapshot.admitted, 1);
      assert.deepEqual(snapshot.bySelector[`kilo/${SMOKE_MODEL}`].statuses, [429]);
    },
  );
});

test("the upstream deadline aborts the request and answers 504", async () => {
  const calls = [];
  await withGateway(
    { routes: SMOKE_SELECTORS, providerKeys: { kilo: REAL_KILO_KEY }, fetchImpl: hangingUpstream(calls), upstreamTimeoutMs: 120 },
    async (gateway) => {
      const response = await postJson({
        port: gateway.port,
        urlPath: "/kilo/v1/chat/completions",
        bearer: gateway.bearer,
        body: CHAT_BODY,
      });
      assert.equal(response.status, 504);
      assert.equal(calls.length, 1, "the deadline never produces a second attempt");
      assert.equal(gateway.snapshot().bySelector[`kilo/${SMOKE_MODEL}`].statuses.at(-1), "timeout");
    },
  );
});

test("a body that stalls after the headers is still aborted by the deadline", async () => {
  const calls = [];
  await withGateway(
    {
      routes: SMOKE_SELECTORS,
      providerKeys: { kilo: REAL_KILO_KEY },
      fetchImpl: stalledBodyUpstream(calls),
      upstreamTimeoutMs: 120,
    },
    async (gateway) => {
      // Without a live deadline this promise never settles: the stub sends
      // headers and then nothing, forever. Race it so a regression fails fast
      // instead of hanging the suite.
      const response = await Promise.race([
        postJson({
          port: gateway.port,
          urlPath: "/kilo/v1/chat/completions",
          bearer: gateway.bearer,
          body: CHAT_BODY,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("relay never ended the stalled stream")), 3000)),
      ]);
      assert.equal(response.status, 200, "headers reached the client before the stall");
      assert.equal(response.text, "");
      assert.equal(calls.length, 1, "the deadline never produces a second attempt");
      assert.equal(
        gateway.snapshot().bySelector[`kilo/${SMOKE_MODEL}`].statuses.at(-1),
        "timeout",
        "the stalled body is recorded as a timeout so the caller can skip it",
      );
    },
  );
});

/** Headers immediately, then a body that never emits or closes until aborted. */
function stalledBodyUpstream(calls) {
  return (input, init = {}) => {
    calls.push({ input, init });
    const { signal } = init;
    const body = new ReadableStream({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.error(abortError());
            } catch {
              // Already terminated; nothing to signal.
            }
          },
          { once: true },
        );
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };
}

test("a client disconnect cancels the in-flight upstream request", async () => {
  const calls = [];
  await withGateway(
    { routes: SMOKE_SELECTORS, providerKeys: { kilo: REAL_KILO_KEY }, fetchImpl: hangingUpstream(calls) },
    async (gateway) => {
      const payload = JSON.stringify(CHAT_BODY);
      await new Promise((resolveDone) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: gateway.port,
            path: "/kilo/v1/chat/completions",
            method: "POST",
            headers: {
              authorization: `Bearer ${gateway.bearer}`,
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(payload)),
            },
          },
          (res) => {
            // Headers arrived only if the upstream answered; with a hanging
            // upstream this never fires, so destroying below is the flow.
            res.resume();
          },
        );
        req.on("error", () => resolveDone()); // expected: our own destroy
        req.end(payload);
        (async () => {
          // Bounded: if the relay rejects the request locally, `calls` never
          // fills and this loop would hang instead of failing the assertion.
          const deadline = Date.now() + 2000;
          while (calls.length === 0 && Date.now() < deadline) await sleep(5);
          await sleep(20);
          req.destroy();
          resolveDone();
        })();
      });
      assert.equal(calls.length, 1, "the request was admitted before the disconnect");
      for (let i = 0; i < 100 && !calls[0].init.signal.aborted; i += 1) {
        await sleep(10);
      }
      assert.equal(calls[0].init.signal.aborted, true, "upstream was cancelled on client disconnect");
    },
  );
});

// The suite above binds a handful of loopback sockets only; no test reaches
// the internet.
test("translation helpers and generated yaml stay within the smoke namespace", () => {
  assert.equal(toSmokeSelector("kilo/z-ai/glm-4.5-air:free"), "smoke-kilo/z-ai/glm-4.5-air:free");
  assert.equal(
    toSmokeSelector("openrouter/meta-llama/llama-3.3-70b-instruct:free"),
    "smoke-openrouter/meta-llama/llama-3.3-70b-instruct:free",
  );
  assert.equal(toSmokeSelector("gpt/z-ai/glm-4.5-air:free"), null);
  assert.equal(toSmokeSelector("free"), null);
  assert.equal(publicSelectorFromSmokeIdentity("smoke-kilo/z-ai/glm-4.5-air:free"), "kilo/z-ai/glm-4.5-air:free");
  assert.equal(publicSelectorFromSmokeIdentity("kilo/z-ai/glm-4.5-air:free"), null);
  assert.equal(publicSelectorFromSmokeIdentity("other/thing"), null);

  const routes = [
    { selector: "kilo/z-ai/glm-4.5-air:free", provider: "kilo", catalogId: "z-ai/glm-4.5-air:free", entry: { context_length: 98_304, max_completion_tokens: 49152 } },
    { selector: "openrouter/meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", catalogId: "meta-llama/llama-3.3-70b-instruct:free", entry: {} },
    { selector: "kilo/deepseek/deepseek-r1:free", provider: "kilo", catalogId: "deepseek/deepseek-r1:free", entry: { context_length: 163_840 } },
  ];
  const yaml = renderSmokeProvidersYaml({ routes, bearer: "smoke-per-run-bearer", port: 41_987 });
  assert.match(yaml, /smoke-kilo:/);
  assert.match(yaml, /smoke-openrouter:/);
  assert.match(yaml, /apiKey: smoke-per-run-bearer/);
  assert.match(yaml, /- id: "z-ai\/glm-4\.5-air:free"/);
  assert.match(yaml, /- id: "meta-llama\/llama-3\.3-70b-instruct:free"/);
  assert.match(yaml, /- id: "deepseek\/deepseek-r1:free"/);
  assert.match(yaml, /contextWindow: 98304/);
  assert.match(yaml, /contextWindow: 163840/);
  assert.equal((yaml.match(/baseUrl: http:\/\/127\.0\.0\.1:41987/g) ?? []).length, 2);
  // The public catalog selectors appear only as comments; OMP must not be able
  // to resolve them inside the sandbox.
  assert.match(yaml, /# public selector: kilo\/z-ai\/glm-4\.5-air:free/);
  assert.doesNotMatch(yaml, /^ {0,2}[a-z-]*:\s*kilo\//m);
  assert.doesNotMatch(yaml, /reasoning: true/);
  // Exactly two provider blocks (one per provider present in the trio).
  assert.equal((yaml.match(/^  smoke-[a-z]+:$/gm) ?? []).length, 2);
});

// Provider-count sanity for whatever `node --test` glob pulls this file in.
assert.deepEqual(PROVIDER_NAMES, ["kilo", "openrouter"]);
