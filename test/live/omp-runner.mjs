// Real-OMP invocation and transcript reading for the optional live suite.
//
// This file is deliberately NOT named *.test.mjs: `npm test` globs that pattern,
// and these checks spend real provider turns, so they run only when asked
// (`npm run test:live`).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Resolve the OMP binary: explicit override, then PATH, then the bun global bin. */
export function resolveOmpBin() {
  const override = process.env.OMP_BIN;
  if (override && override.length > 0) return override;
  const bunBin = path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
    ".bun",
    "bin",
    process.platform === "win32" ? "omp.exe" : "omp",
  );
  return existsSync(bunBin) ? bunBin : "omp";
}

/**
 * Run the installed OMP and capture stdout/stderr with a hard wall-clock cap.
 *
 * stdin is `ignore`, not a pipe: OMP reads piped stdin at startup
 * (`readPipedInput`) and waits for the pipe to close, so handing it an open
 * pipe that is never written blocks the whole run before any model call.
 */
export function runOmp(args, { cwd, env, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const bin = resolveOmpBin();
    const child = spawn(bin, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\nspawn error: ${err.message}`, timedOut, bin });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, bin });
    });
  });
}

/** `omp <args> --json` style calls return a single JSON document on stdout. */
export function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some commands wrap or precede the document; fall back to the first array/object.
    const start = trimmed.search(/[[{]/);
    if (start < 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return undefined;
    }
  }
}

/** Every session transcript under `dir`, newest first. */
export function findSessionFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          out.push({ file: full, mtimeMs: statSync(full).mtimeMs });
        } catch {
          // Ignore files that vanish mid-scan.
        }
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Extract what OMP actually did from a session transcript.
 *
 * The assistant `message.model`/`provider` fields are recorded by the host for
 * the turn it actually ran, so they are the routing evidence. Extension log
 * lines are intentionally not used: they record what the extension asked for,
 * which is exactly the claim under test.
 */
export function readTranscript(file) {
  const raw = readFileSync(file, "utf8");
  const result = {
    file,
    header: undefined,
    modelsApplied: [],
    assistantModels: [],
    userTurns: 0,
  };
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    if (entry.type === "session") {
      result.header = entry;
      continue;
    }
    if (entry.type === "model_change" && typeof entry.model === "string") {
      result.modelsApplied.push(entry.model);
      continue;
    }
    if (entry.type === "message" && entry.message !== null && typeof entry.message === "object") {
      const message = entry.message;
      if (message.role === "user") result.userTurns += 1;
      if (message.role === "assistant" && typeof message.model === "string") {
        result.assistantModels.push(
          typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model,
        );
      }
    }
  }
  return result;
}
