import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist/mistral-live.js");

function makeHost() {
  const registered = [];
  const logs = [];
  const pi = {
    registerProvider(name, config) {
      registered.push({ name, config });
    },
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
      debug: (...a) => logs.push(["debug", a.join(" ")]),
    },
  };
  return { pi, registered, logs };
}

describe("mistral-live extension", () => {
  it("registers mistral provider without overriding apiKey", () => {
    const { pi, registered } = makeHost();
    mod.default(pi, { env: {} });

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "mistral");
    assert.equal(registered[0].config.baseUrl, "https://api.mistral.ai/v1");
    assert.equal(registered[0].config.api, "openai-completions");
    assert.equal("apiKey" in registered[0].config, false);
    assert.equal(typeof registered[0].config.fetchDynamicModels, "function");
  });

  it("respects OMP_MISTRAL_LIVE_DISABLE kill switch", () => {
    const { pi, registered } = makeHost();
    mod.default(pi, { env: { OMP_MISTRAL_LIVE_DISABLE: "1" } });
    assert.equal(registered.length, 0);
  });

  it("fails open with warning when host lacks registerProvider", () => {
    const logs = [];
    const pi = {
      logger: { warn: (...a) => logs.push(a.join(" ")) },
    };
    assert.doesNotThrow(() => mod.default(pi, { env: {} }));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /registerProvider/);
  });

  it("normalizes custom baseUrl, rejects non-loopback HTTP, and preserves query strings on /models", () => {
    const host1 = makeHost();
    mod.default(host1.pi, { env: { OMP_MISTRAL_LIVE_BASE_URL: "https://proxy.example.com/v1///" } });
    assert.equal(host1.registered[0].config.baseUrl, "https://proxy.example.com/v1");

    // Non-loopback plain HTTP must be rejected to protect Bearer tokens in transit.
    const host2 = makeHost();
    mod.default(host2.pi, { env: { OMP_MISTRAL_LIVE_BASE_URL: "http://proxy.example.com/v1" } });
    assert.equal(host2.registered[0].config.baseUrl, "https://api.mistral.ai/v1");
    assert.ok(host2.logs.some(([level]) => level === "warn"));

    // Loopback HTTP is allowed for local development proxies.
    const host3 = makeHost();
    mod.default(host3.pi, { env: { OMP_MISTRAL_LIVE_BASE_URL: "http://127.0.0.1:4000/v1/" } });
    assert.equal(host3.registered[0].config.baseUrl, "http://127.0.0.1:4000/v1");

    // Query strings stay attached after `/models` is appended to the pathname.
    assert.equal(
      mod.buildModelsEndpointUrl("https://proxy.example.com/v1?api-version=2026-01"),
      "https://proxy.example.com/v1/models?api-version=2026-01",
    );
  });

  it("filters out non-chat models, maps capabilities + numeric string context, and deduplicates IDs", () => {
    const payload = {
      object: "list",
      data: [
        {
          id: "mistral-large-4",
          name: "mistral-large-4-0",
          max_context_length: 1000000,
          capabilities: { completion_chat: true, vision: true, reasoning: true },
        },
        {
          id: "mistral-large-latest",
          name: "mistral-large-latest",
          aliases: ["mistral-large-4-0", "mistral-large-2512"],
          max_context_length: "512000",
          capabilities: { completion_chat: true, vision: true, reasoning: true },
        },
        {
          id: "mistral-embed",
          max_context_length: 8192,
          capabilities: { completion_chat: false },
        },
        {
          id: "mistral-ocr-latest",
          capabilities: { completion_chat: false, vision: true },
        },
        {
          id: "mistral-large-4",
          max_context_length: 64000,
          capabilities: { completion_chat: true },
        },
        {
          id: "custom-gateway-model",
          // No capabilities object (OpenAI-compatible gateway) — must be kept.
        },
      ],
    };

    const models = mod.parseMistralModelsPayload(payload);
    assert.deepEqual(
      models.map((m) => m.id),
      ["mistral-large-4", "mistral-large-latest", "custom-gateway-model"],
    );

    const large4 = models[0];
    assert.equal(large4.reasoning, true);
    assert.deepEqual(large4.input, ["text", "image"]);
    assert.equal(large4.contextWindow, 1000000);
    assert.deepEqual(large4.thinking, {
      mode: "effort",
      efforts: ["low", "medium", "high"],
      defaultLevel: "medium",
    });

    // Alias of mistral-large-4-0 gets the low/medium/high effort ladder and numeric string context.
    const latest = models[1];
    assert.equal(latest.contextWindow, 512000);
    assert.deepEqual(latest.thinking, {
      mode: "effort",
      efforts: ["low", "medium", "high"],
      defaultLevel: "medium",
    });

    const gateway = models[2];
    assert.equal(gateway.reasoning, false);
    assert.deepEqual(gateway.input, ["text"]);
    assert.equal(gateway.contextWindow, mod.DEFAULT_CONTEXT_WINDOW);
    assert.equal("thinking" in gateway, false);
  });

  it("rejects malformed model rows instead of publishing an empty catalog", () => {
    assert.throws(
      () => mod.parseMistralModelsPayload({ data: [null, { name: "missing-id" }] }),
      /malformed model entry/,
    );
    assert.throws(
      () => mod.parseMistralModelsPayload({ data: [{ id: "   ", capabilities: { completion_chat: true } }] }),
      /malformed model entry/,
    );
  });

  it("throws on missing apiKey, HTTP error, or malformed payload so cache fallback works", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });

    await assert.rejects(
      () => mod.fetchMistralLiveModels(undefined, { fetch: fakeFetch }),
      /missing Mistral API key/,
    );
    await assert.rejects(
      () => mod.fetchMistralLiveModels("   ", { fetch: fakeFetch }),
      /missing Mistral API key/,
    );

    await assert.rejects(
      () =>
        mod.fetchMistralLiveModels("test-secret-key", {
          fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
        }),
      (err) => {
        assert.match(err.message, /HTTP 503/);
        // Must never leak the API key in error messages.
        assert.equal(err.message.includes("test-secret-key"), false);
        return true;
      },
    );

    await assert.rejects(
      () =>
        mod.fetchMistralLiveModels("test-secret-key", {
          fetch: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
        }),
      /missing data array/,
    );
  });

  it("sends Bearer auth header to <baseUrl>/models and returns live chat models", async () => {
    const calls = [];
    const { pi, registered } = makeHost();
    mod.default(pi, {
      baseUrl: "https://api.mistral.ai/v1/",
      env: {},
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "brand-new-mistral-2027",
                max_context_length: 256000,
                capabilities: { completion_chat: true, vision: false, reasoning: true },
              },
            ],
          }),
        };
      },
    });

    const result = await registered[0].config.fetchDynamicModels("sk-live-123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.mistral.ai/v1/models");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-live-123");
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "brand-new-mistral-2027");
    assert.equal(result[0].contextWindow, 256000);
    assert.equal(result[0].reasoning, true);
  });

  it("registered fetchDynamicModels rejects a 200 payload with a valid row followed by a malformed row", async () => {
    const calls = [];
    const { pi, registered } = makeHost();
    mod.default(pi, {
      env: {},
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "mistral-fresh-2030",
                max_context_length: 128000,
                capabilities: { completion_chat: true },
              },
              { name: "row-without-id" },
            ],
          }),
        };
      },
    });

    // The valid first row must not be published as a partial roster.
    await assert.rejects(
      () => registered[0].config.fetchDynamicModels("sk-live-123"),
      /malformed model entry/,
    );
    assert.equal(calls.length, 1);
  });

  it("registered fetchDynamicModels rejects invalid JSON and never fetches on a blank credential", async () => {
    let fetchCount = 0;
    const { pi, registered } = makeHost();
    mod.default(pi, {
      env: {},
      fetch: async () => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError(`Unexpected token '<', "<html>..." is not valid JSON`);
          },
        };
      },
    });

    // Malformed JSON must reject so oh-my-pi keeps its cached catalog.
    await assert.rejects(
      () => registered[0].config.fetchDynamicModels("sk-live-123"),
      SyntaxError,
    );
    assert.equal(fetchCount, 1);

    // Blank/missing credentials fail before any network work.
    await assert.rejects(
      () => registered[0].config.fetchDynamicModels("   "),
      /missing Mistral API key/,
    );
    await assert.rejects(
      () => registered[0].config.fetchDynamicModels(undefined),
      /missing Mistral API key/,
    );
    assert.equal(fetchCount, 1);
  });

  // Fetch double that settles only when its abort signal fires, so a request
  // that is never aborted fails the test (sentinel rejection) instead of hanging it.
  function abortWaitingFetch(observed) {
    return async (_url, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("mistral-live test: fetch double received no AbortSignal");
      }
      observed.push(signal);
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new Error("mistral-live test: already aborted"));
          return;
        }
        const bail = setTimeout(() => {
          reject(new Error("mistral-live test: fetch double was never aborted"));
        }, 2000);
        bail.unref?.();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(bail);
            reject(signal.reason ?? new Error("mistral-live test: aborted without reason"));
          },
          { once: true },
        );
      });
    };
  }

  it("registered fetchDynamicModels rejects when the real AbortSignal.timeout fires mid-request", async () => {
    const { pi, registered } = makeHost();
    const observed = [];
    mod.default(pi, {
      env: {},
      timeoutMs: 40,
      fetch: abortWaitingFetch(observed),
    });

    await assert.rejects(
      () => registered[0].config.fetchDynamicModels("sk-live-timeout"),
      (err) => err?.name === "TimeoutError" || /timed out|aborted/i.test(String(err?.message ?? "")),
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0].aborted, true);
    assert.equal(observed[0].reason?.name, "TimeoutError");
  });

  it("falls back to AbortController when AbortSignal.timeout is unavailable and rejects via the fallback timer", async () => {
    const originalTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const { pi, registered } = makeHost();
      const observed = [];
      mod.default(pi, {
        env: {},
        timeoutMs: 40,
        fetch: abortWaitingFetch(observed),
      });

      await assert.rejects(
        () => registered[0].config.fetchDynamicModels("sk-live-fallback"),
        /request timed out/,
      );
      assert.equal(observed.length, 1);
      assert.equal(observed[0].aborted, true);
      assert.match(String(observed[0].reason?.message ?? ""), /request timed out/);
    } finally {
      Object.defineProperty(AbortSignal, "timeout", {
        value: originalTimeout,
        configurable: true,
        writable: true,
      });
    }
  });
});
