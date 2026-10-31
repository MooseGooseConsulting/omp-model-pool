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

/**
 * Build a model registry from `["provider/id", ...]`.
 *
 * `resolve` matches `provider/id` or a bare `id`; role aliases (`@slow`) never
 * resolve, matching the host. `currentSpec` seeds the active model, and
 * `setCurrent` lets a test change it mid-flow (for the "host keeps a different
 * model" case).
 */
export function makeModels(available, currentSpec) {
  const parsed = available.map(parseSelector);
  let current;

  function find(spec) {
    const text = String(spec).trim();
    if (text.startsWith("@")) return undefined;
    const found = parsed.find(
      (m) => `${m.provider}/${m.id}` === text || m.id === text,
    );
    return found ? { ...found } : undefined;
  }

  if (currentSpec !== undefined && currentSpec !== null) current = find(currentSpec);

  return {
    list: () => parsed.map((m) => ({ ...m })),
    current: () => (current ? { ...current } : undefined),
    resolve: (spec) => find(spec),
    setCurrent: (spec) => {
      current = spec === undefined || spec === null ? undefined : find(spec);
    },
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
    models: (available, currentSpec) => makeModels(available, currentSpec),
    mainCtx: (models, overrides = {}) => makeCtx(host, "main", models, overrides),
    subCtx: (models, overrides = {}) => makeCtx(host, "sub", models, overrides),
  };

  return host;
}
