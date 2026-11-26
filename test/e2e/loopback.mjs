// Deterministic loopback fixture for the real-OMP E2E suite (test/e2e).
//
// One HTTP server bound to 127.0.0.1 answers everything the cases need and
// nothing else:
//   * `POST /v1/chat/completions` — OpenAI Chat Completions shaped as SSE,
//     with its branch chosen from the request's own shape (see below);
//   * `GET /v1/models` — a Mistral-shaped roster queue, one entry per
//     `models refresh` the mistral-live case performs.
//
// Invariants this module keeps:
//   * Nothing that could identify a credential is recorded or printed: the
//     Authorization header is only ever compared against the dummy fixture
//     key, and requests are reduced to routing facts
//     (`path`, `model`, `reasoningEffort`, `tools`, `hasToolMessage`).
//   * Proxy-shaped traffic (absolute-form request line, CONNECT) is destroyed
//     without a response and without dialing out, so a mis-routed ambient
//     catalog probe from the sandbox cannot open an outbound connection.
//   * Unexpected paths, unknown fixture models, malformed bodies, oversize
//     bodies and a request count beyond the ceiling are rejected; every
//     rejection reason (fixture ids only, never bodies or headers) is
//     recorded so the suite can turn it into a failure.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";

const CHAT_PATH = "/v1/chat/completions";

/** The one custom provider the fixture describes; models.yml and selectors agree on it. */
export const FIXTURE_PROVIDER = "pool-fixture";
/** Dummy bearer on the pool-fixture chat provider row. */
export const FIXTURE_API_KEY = "pool-fixture-key";
/** Dummy bearer the mistral-live case sends on `GET /v1/models` (mirrors its MISTRAL_API_KEY). */
export const MISTRAL_FIXTURE_API_KEY = "mistral-fixture-key";

/** Exact model rows the generated models.yml declares. */
export const FIXTURE_MODEL_IDS = ["pin", "a", "b", "slow-a", "slow-b"];
/** Models with a thinking ladder (must never be sent a level outside it). */
export const FIXTURE_THINKING_MODEL_IDS = ["b", "slow-a"];

const MODEL_ID_SET = new Set(FIXTURE_MODEL_IDS);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Stable SSE timestamps; the suite asserts on shapes, not clocks. */
const SSE_CREATED = 1_730_000_000;
const TASK_PROMPT = "Reply with exactly: OK";
const YIELD_RESULT = { data: { overall_correctness: "correct", explanation: "Fixture response", confidence: 1 } };

/**
 * Reduce a wire `model` value to a fixture model id. Accepts the bare id and
 * the `pool-fixture/<id>` spelling; anything else is unknown and rejected.
 */
export function toFixtureModel(wire, provider = FIXTURE_PROVIDER) {
  if (typeof wire !== "string") return undefined;
  const text = wire.trim();
  if (text.length === 0) return undefined;
  const prefix = `${provider}/`;
  const bare = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return MODEL_ID_SET.has(bare) ? bare : undefined;
}

/** Tool function names advertised on a request body, or an empty list. */
function toolNames(tools) {
  if (!Array.isArray(tools)) return [];
  const names = [];
  for (const entry of tools) {
    if (entry === null || typeof entry !== "object") continue;
    const fromFunction = entry.function && typeof entry.function === "object" ? entry.function.name : undefined;
    const name = typeof fromFunction === "string" ? fromFunction : entry.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

/** Bit most assertions care about: did the request carry a `reasoning_effort`? */
function normalizeEffort(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : "[object]";
}

/**
 * Start the fixture. Resolves once the server is listening.
 *
 * Returns live captures/rejections arrays plus the small control surface the
 * suite needs (roster queue per refresh, delegation script per run, stats,
 * close). The returned `captures` match the capture contract:
 * `{ path, model, reasoningEffort }` plus the two response-shaping facts
 * (`tools`, `hasToolMessage`) the model-match assertions need.
 */
export async function startLoopbackFixture({ provider = FIXTURE_PROVIDER, apiKey = FIXTURE_API_KEY, mistralApiKey = MISTRAL_FIXTURE_API_KEY, maxCapturedRequests = 300 } = {}) {
  const state = {
    captures: [],
    rejections: [],
    rosterQueue: [],
    delegationScript: [],
    delegationEmitted: 0,
    chatRequests: 0,
    modelsRequests: 0,
    unauthenticatedModelsRequests: 0,
    refusedConnections: 0,
    overrun: false,
    responseCounter: 0,
  };

  const server = createServer((req, res) => {
    void serveRequest(req, res, state, { provider, apiKey, mistralApiKey, maxCapturedRequests });
  });
  // A CONNECT attempt means some client resolved a host through us as an HTTP
  // proxy. Destroy the socket; no tunnel, no response, no outbound dial.
  server.on("connect", (_req, socket) => {
    state.refusedConnections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // The suite closes the server explicitly; never block process exit on it.
  server.unref?.();

  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    captures: state.captures,
    rejections: state.rejections,
    /** Arm (after clearing) the sequential task-delegation script for the next parent run. */
    setDelegationScript(plan) {
      state.delegationScript = [...plan];
      state.delegationEmitted = 0;
    },
    /** Queue the next `/v1/models` payload; one entry is consumed per authenticated refresh. */
    enqueueMistralRoster(payload) {
      state.rosterQueue.push(payload);
    },
    stats() {
      return {
        chatRequests: state.chatRequests,
        modelsRequests: state.modelsRequests,
        unauthenticatedModelsRequests: state.unauthenticatedModelsRequests,
        refusedConnections: state.refusedConnections,
        overrun: state.overrun,
      };
    },
    /** Stop the server and drop its sockets. Resolves true when listening ended. */
    async close() {
      try {
        server.closeAllConnections?.();
      } catch {
        // Sockets may already be gone.
      }
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      return !server.listening;
    },
  };
}

async function serveRequest(req, res, state, { provider, apiKey, mistralApiKey, maxCapturedRequests }) {
  try {
    // Absolute-form request line = HTTP proxy traffic that ignored NO_PROXY.
    // Refuse without a response: nothing here may open an outbound connection.
    if (/^https?:\/\//i.test(req.url ?? "")) {
      state.refusedConnections += 1;
      res.destroy();
      return;
    }
    const method = (req.method ?? "").toUpperCase();
    if (method === "GET" && req.url === "/v1/models") {
      serveMistralRoster(req, res, state, mistralApiKey);
      return;
    }
    if (method !== "POST" || req.url !== "/v1/chat/completions") {
      rejectRequest(res, state, `unexpected request ${method} ${req.url === "/v1/models" ? "/v1/models (wrong method)" : req.url ?? "(no url)"}`, 404);
      return;
    }

    const raw = [];
    let size = 0;
    let oversize = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversize = true;
        break;
      }
      raw.push(chunk);
    }
    if (oversize) {
      rejectRequest(res, state, "request body exceeded the fixture cap", 413);
      res.destroy();
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(raw).toString("utf8"));
    } catch {
      rejectRequest(res, state, "malformed JSON request body", 400);
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      rejectRequest(res, state, "request body was not a JSON object", 400);
      return;
    }

    if (state.captures.length >= maxCapturedRequests) {
      state.overrun = true;
      rejectRequest(res, state, "fixture request cap exceeded", 503);
      return;
    }

    serveChatCompletion(res, state, body, { provider });
  } catch {
    // Never leak raw request errors to the suite log; the recorded rejection
    // reason (static text, no bodies) is the audit trail.
    try {
      res.destroy();
    } catch {
      // Socket already gone.
    }
  }
}

function rejectRequest(res, state, reason, status) {
  state.rejections.push({ reason });
  if (!res.writableEnded) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: reason, type: "fixture_rejected" } }));
  }
}

function serveMistralRoster(req, res, state, apiKey) {
  // Deliberately scoped: the bearer value is compared against the dummy
  // fixture key and never copied to state or logs.
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${apiKey}`) {
    state.unauthenticatedModelsRequests += 1;
    rejectRequest(res, state, "unauthenticated /v1/models request", 401);
    return;
  }
  if (state.rosterQueue.length === 0) {
    // A fetch we did not queue for must fail loudly, not silently serve a
    // stale roster that could make a case pass by luck.
    rejectRequest(res, state, "fixture model roster exhausted", 500);
    return;
  }
  const payload = state.rosterQueue.shift();
  state.modelsRequests += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function serveChatCompletion(res, state, body, { provider }) {
  const model = toFixtureModel(body.model, provider);
  if (model === undefined) {
    rejectRequest(res, state, `fixture received a request for an unknown model (${typeof body.model === "string" ? body.model : "non-string"})`, 400);
    return;
  }
  const tools = toolNames(body.tools);
  const hasToolMessage =
    Array.isArray(body.messages) &&
    body.messages.some((m) => m !== null && typeof m === "object" && m.role === "tool");
  state.captures.push({
    path: CHAT_PATH,
    model,
    reasoningEffort: normalizeEffort(body.reasoning_effort),
    tools,
    hasToolMessage,
  });
  state.chatRequests += 1;

  const chunks = buildChunks(state, model, tools, hasToolMessage);
  state.responseCounter += 1;
  const id = `chatcmpl-e2e-${state.responseCounter}`;
  const lines = chunks.map(
    (chunk) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: SSE_CREATED, model: body.model, ...chunk })}\n\n`,
  );
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.write(lines.join(""));
  res.end("data: [DONE]\n\n");
}

/**
 * One SSE response, chosen from the request's own shape:
 *   1. delegation script armed and not exhausted + (task tool advertised or a
 *      tool result present) → one `task` tool call from the script;
 *   2. otherwise a `yield` tool call when the reviewer advertises one;
 *   3. otherwise a plain content answer.
 * A follow-up after the script is exhausted answers plain `OK`, which is what
 * stops the parent from spawning again.
 */
function buildChunks(state, model, tools, hasToolMessage) {
  const scripted = state.delegationScript;
  const mayDelegate = scripted.length > 0 && state.delegationEmitted < scripted.length;
  if (mayDelegate && (tools.includes("task") || hasToolMessage)) {
    const plan = scripted[state.delegationEmitted];
    state.delegationEmitted += 1;
    return [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_e2e_task_${state.responseCounter + 1}`,
                  type: "function",
                  function: {
                    name: "task",
                    arguments: JSON.stringify({
                      name: plan.name,
                      agent: plan.agent,
                      task: TASK_PROMPT,
                      solutionSpace: typeof plan.solutionSpace === "string" ? plan.solutionSpace : "one fixed response",
                    }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
  }
  if (tools.includes("yield")) {
    return [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_e2e_yield_${state.responseCounter + 1}`,
                  type: "function",
                  function: { name: "yield", arguments: JSON.stringify(YIELD_RESULT) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
  }
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

/**
 * Write `<agentDir>/models.yml` for the `pool-fixture` custom provider.
 *
 * Rows are exact: every case spawns only these ids, so a request for anything
 * else is a routing defect and is rejected by the fixture. `b` and `slow-a`
 * carry the effort ladder the pool selectors decorate (`:high`).
 */
export function writeModelsYaml(agentDir, port, { provider = FIXTURE_PROVIDER, apiKey = FIXTURE_API_KEY } = {}) {
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, "models.yml");
  const model = (id, decorate) => {
    const lines = [
      `      - id: ${id}`,
      `        name: ${id}`,
      "        input: [text]",
      "        contextWindow: 64000",
      "        maxTokens: 1024",
    ];
    if (decorate) {
      lines.push(
        "        reasoning: true",
        "        thinking:",
        "          mode: effort",
        "          efforts: [low, medium, high]",
        "          defaultLevel: low",
        "        compat:",
        "          supportsReasoningEffort: true",
        "          thinkingFormat: openai",
      );
    }
    return lines;
  };
  const rows = FIXTURE_MODEL_IDS.map((id) => model(id, FIXTURE_THINKING_MODEL_IDS.includes(id)));
  const yaml = [
    "providers:",
    `  ${provider}:`,
    `    baseUrl: "http://127.0.0.1:${port}/v1"`,
    "    api: openai-completions",
    `    apiKey: ${apiKey}`,
    "    models:",
    ...rows.flat(),
    "",
  ].join("\n");
  writeFileSync(file, yaml, "utf8");
  return file;
}

/**
 * Override the bundled `scout` agent so it routes on the `slow` role.
 *
 * The bundled scout has no `@slow` model, which would make the wraparound
 * case's middle spawn pass through unrotated; a user agent file with the same
 * name (documented OMP behavior, same mechanism as `omp agents unpack`) pins
 * it to the role under test. The fixture answers the scout child like any
 * other, so this only changes routing.
 */
export function writeScoutAgent(agentDir) {
  const agentsDir = path.join(agentDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, "scout.md");
  writeFileSync(
    file,
    [
      "---",
      "name: scout",
      'description: "Read-only scout for the loopback E2E; routed on the slow role"',
      'model: "@slow"',
      "---",
      "Complete the assigned read-only task.",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}
