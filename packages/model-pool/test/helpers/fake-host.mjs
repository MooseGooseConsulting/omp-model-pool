// Fake OMP host for the `/model-pool` command surface.
//
// Mirrors the structural contract `src/index.ts` depends on: `pi.on`,
// `pi.setModel`, `pi.logger`, an optional `pi.registerCommand`, and a
// `ctx.ui` with `select` / `input` / `confirm` / `notify`. Dialogs are driven
// by queues so a test can script exactly what the user picks and can leave a
// queue empty to exercise "cancelled". Nothing here touches the network or the
// filesystem.

function parseSelector(spec) {
  const slash = spec.indexOf("/");
  return slash >= 0
    ? { provider: spec.slice(0, slash), id: spec.slice(slash + 1) }
    : { provider: "", id: spec };
}

// `:level` may trail the whole selector or the id segment, and `@upstream` may
// sit on either side of the colon. Only the level token is an effort request:
// `provider/id:high`, `provider/id:high@upstream` and
// `provider/id@upstream:high` all mean "set level `level` for `provider/id`".
function parseEffortSelector(spec) {
  const text = String(spec ?? "").trim();
  const colon = text.indexOf(":");
  if (colon < 0) return { body: text, upstream: undefined, level: undefined };
  const at = text.indexOf("@", colon);
  if (at >= 0) {
    return {
      body: text.slice(0, at),
      upstream: text.slice(at + 1),
      level: text.slice(colon + 1, at),
    };
  }
  return {
    body: text.slice(0, colon),
    upstream: undefined,
    level: text.slice(colon + 1),
  };
}

const KNOWN_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// A case-sensitive unique prefix of at least two characters resolves to the
// canonical level; `:hi` is `high` because no other level starts with "hi".
function canonicalLevel(token) {
  const tokenText = String(token ?? "");
  if (!tokenText) return undefined;
  if (KNOWN_LEVELS.includes(tokenText)) return tokenText;
  const hits = KNOWN_LEVELS.filter((level) => level.startsWith(tokenText));
  return hits.length === 1 ? hits[0] : undefined;
}

// Bare role name -> ordered selector array. Tests may dispatch by role; the
// registry never invents a default mapping on its own.
function normalizeRoleMap(roles = {}) {
  const out = {};
  for (const [name, selectors] of Object.entries(roles)) {
    out[String(name).replace(/^@/, "")] = [...selectors];
  }
  return out;
}

export function makeModels(available, currentSpec, roles = {}) {
  const parsed = available.map(parseSelector);
  const models = normalizeRoleMap(roles);
  let current;

  function findPlain(text) {
    const want = String(text ?? "").trim();
    if (!want || want.startsWith("@")) return undefined;
    return (
      parsed.find((m) => `${m.provider}/${m.id}` === want || m.id === want) ??
      undefined
    );
  }

  function resolveCanonical(text) {
    const want = String(text ?? "").trim();
    if (!want || want.startsWith("@")) return undefined;
    return findPlain(want) ?? findPlain(want.replace(/^.*\//, "")) ?? undefined;
  }

  function resolveAlias(base, level) {
    const bare = String(base ?? "").replace(/^@/, "");
    const selectors = models[bare];
    if (!selectors || selectors.length === 0) return undefined; // unknown alias
    for (const sel of selectors) {
      const hit = find(sel);
      if (hit) return { ...hit };
    }
    return undefined; // exhausted: every entry unresolvable
  }

  function find(spec) {
    const text = String(spec ?? "").trim();
    const parsedSel = parseEffortSelector(text);
    const body = text.startsWith("@") ? text : parsedSel.body;
    const level = parsedSel.level;

    if (text.startsWith("@")) {
      // `@alias[:level]` is a role selector. The FIRST resolving configured
      // entry wins; an unknown alias or an exhausted list is `undefined`.
      const at = body.indexOf(":");
      if (at > 0 && level) {
        const canonical = canonicalLevel(level);
        if (!canonical) return undefined;
        const hit = resolveAlias(body.slice(0, at), canonical);
        if (!hit) return undefined;
        return { ...hit };
      }
      const hit = resolveAlias(body.replace(/^@/, ""));
      return hit ? { ...hit } : undefined;
    }

    // Concrete or bare id, optionally with an effort suffix. Literal ids win,
    // and the caller receives exactly the registry row: a real host hands the
    // extension its own model object, so a double that decorates it with
    // bookkeeping fields would make "the applied model" a different object
    // than the one a host stores.
    return resolveCanonical(body) ?? undefined;
  }

  if (currentSpec !== undefined && currentSpec !== null) current = find(currentSpec);

  return {
    list: () => parsed.map((m) => ({ ...m })),
    current: () => (current ? { ...current } : undefined),
    resolve: (spec) => find(spec),
    setCurrent: (spec) => {
      current = spec === undefined || spec === null ? undefined : find(spec);
    },
    models,
  };
}

function makeCtx(host, kind, models, overrides) {
  const ctx = {
    agent: { kind, name: kind, id: kind === "main" ? "Main" : "sub" },
    models,
    ui: host.ui,
    hasUI: true,
    isIdle: () => true,
  };
  return Object.assign(ctx, overrides);
}

/**
 * Create a fake host.
 *
 * `options.registerCommand`:
 *   - `true` (default): `pi.registerCommand` captures name + options.
 *   - `false`: the host exposes no `registerCommand` at all.
 *   - `"throw"`: the host has one that throws when called.
 */
export function createFakeHost(options = {}) {
  const handlers = {};
  const logs = [];
  const notified = [];
  const setModels = [];
  const effortCalls = [];
  const command = { registered: false, name: undefined, options: undefined };
  const queues = { select: [], input: [], confirm: [] };
  // Every dialog invocation, for "no dialog was shown" assertions.
  const calls = { select: [], input: [], confirm: [] };

  const ui = {
    select: async (title, opts) => {
      calls.select.push([title, opts]);
      if (queues.select.length === 0) return undefined;
      const next = queues.select.shift();
      return typeof next === "function" ? next(title, opts) : next;
    },
    input: async (title, placeholder) => {
      calls.input.push([title, placeholder]);
      if (queues.input.length === 0) return undefined;
      const next = queues.input.shift();
      return typeof next === "function" ? next(title, placeholder) : next;
    },
    confirm: async (title, message) => {
      calls.confirm.push([title, message]);
      if (queues.confirm.length === 0) return false;
      const next = queues.confirm.shift();
      return typeof next === "function" ? next(title, message) : next;
    },
    notify: (message, type) => {
      notified.push([message, type]);
    },
  };

  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    setModel: async (model) => {
      setModels.push(model);
    },
    setThinkingLevel: (level) => {
      effortCalls.push(level);
    },
    logger: {
      info: (...args) => logs.push(["info", args.join(" ")]),
      warn: (...args) => logs.push(["warn", args.join(" ")]),
      debug: (...args) => logs.push(["debug", args.join(" ")]),
      error: (...args) => logs.push(["error", args.join(" ")]),
    },
  };

  const registerCommandMode =
    options.registerCommand === undefined ? true : options.registerCommand;
  if (registerCommandMode !== false) {
    pi.registerCommand = (name, opts) => {
      if (registerCommandMode === "throw") throw new Error("host refuses command registration");
      command.registered = true;
      command.name = name;
      command.options = opts;
    };
  }

  const host = {
    pi,
    ui,
    handlers,
    logs,
    notified,
    setModels,
    calls,
    queues,
    command,
    pushSelect: (value) => queues.select.push(value),
    pushInput: (value) => queues.input.push(value),
    pushConfirm: (value) => queues.confirm.push(value),
    models: makeModels,
    effortCalls,
    mainCtx: (models, overrides = {}) => makeCtx(host, "main", models, overrides),
    subCtx: (models, overrides = {}) => makeCtx(host, "sub", models, overrides),
  };

  return host;
}
