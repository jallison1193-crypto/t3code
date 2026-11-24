// Inline ESM bootstrap runs from bundles, asar archives, and SEA builds without needing a read
// grant on T3's install directory or writing helper files into the user's plugin folder.
export const PLUGIN_WORKER_BOOTSTRAP_SOURCE = `
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const send = (message) => {
  try {
    rawStdoutWrite(JSON.stringify(message) + "\\n");
  } catch {
    // Host pipe closed while worker is exiting.
  }
};

const formatArgs = (args) =>
  args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : arg instanceof Error
          ? arg.stack || arg.message
          : inspect(arg, { depth: 4, breakLength: 120 }),
    )
    .join(" ");

const sendLog = (level, text) => {
  send({
    jsonrpc: "2.0",
    method: "worker/log",
    params: { level, text },
  });
};

for (const [fn, level] of [
  ["log", "info"],
  ["info", "info"],
  ["warn", "warn"],
  ["error", "error"],
  ["debug", "debug"],
]) {
  console[fn] = (...args) => sendLog(level, formatArgs(args));
}

const hasPermission =
  typeof process.permission === "object" &&
  process.permission !== null &&
  typeof process.permission.has === "function";
const networkLockSupported =
  hasPermission &&
  typeof process.allowedNodeEnvironmentFlags === "object" &&
  process.allowedNodeEnvironmentFlags !== null &&
  process.allowedNodeEnvironmentFlags.has("--allow-net");
const networkBlocked = networkLockSupported && !process.permission.has("net");

send({
  jsonrpc: "2.0",
  method: "worker/hello",
  params: { hasPermission, networkLockSupported, networkBlocked },
});

const pendingHost = new Map();
let nextWorkerReqId = 1;
const callHost = (method, params) =>
  new Promise((resolve, reject) => {
    const id = "w" + String(nextWorkerReqId++);
    pendingHost.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });

let runHandler = null;
let initialized = false;

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error ?? "Unknown error");

const handleMessage = async (msg) => {
  if (typeof msg !== "object" || msg === null || msg.jsonrpc !== "2.0") return;

  if (msg.method === undefined && msg.id !== undefined) {
    const pending = pendingHost.get(msg.id);
    if (pending === undefined) return;
    pendingHost.delete(msg.id);
    if (msg.error !== undefined) {
      pending.reject(new Error(msg.error?.message || "Host RPC failed"));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  const replyOk = (result) => {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
  };
  const replyErr = (message) => {
    if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
    }
  };

  if (msg.method === "host/init") {
    if (initialized) {
      replyErr("Worker already initialized.");
      return;
    }
    try {
      const entryPath = msg.params?.entryPath;
      const rawFolders = msg.params?.folders ?? {};
      if (typeof entryPath !== "string" || entryPath.length === 0) {
        replyErr("Missing worker entryPath.");
        return;
      }
      const folders = Object.freeze({ ...rawFolders });
      const t3 = Object.freeze({
        folders,
        log: (...args) => sendLog("info", formatArgs(args)),
        onRun: (fn) => {
          if (typeof fn !== "function") {
            throw new TypeError("t3.onRun expects a function.");
          }
          runHandler = fn;
        },
        state: Object.freeze({
          get: () => callHost("state/get", {}),
          set: (value) => callHost("state/set", { value }),
        }),
        projects: Object.freeze({
          list: () => callHost("projects/list", {}),
          readMemory: (projectId) => callHost("projects/readMemory", { projectId }),
        }),
      });
      const mod = await import(pathToFileURL(entryPath).href);
      if (typeof mod.default !== "function") {
        replyErr("Worker module must export a default function.");
        return;
      }
      await mod.default(t3);
      initialized = true;
      replyOk({ ok: true, hasRunHandler: runHandler !== null });
    } catch (error) {
      replyErr(errorMessage(error));
    }
    return;
  }

  if (msg.method === "host/run") {
    if (!initialized) {
      replyErr("Worker is not initialized.");
      return;
    }
    if (runHandler === null) {
      replyOk({ ok: true, skipped: true });
      return;
    }
    try {
      const reason = msg.params?.reason ?? "manual";
      await runHandler({ reason });
      replyOk({ ok: true, skipped: false });
    } catch (error) {
      replyErr(errorMessage(error));
    }
    return;
  }

  if (msg.method === "host/shutdown") {
    replyOk({ ok: true });
    process.exit(0);
  }
};

const MAX_STDIN_LINE_CHARS = 8 * 1024 * 1024;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx === -1) {
      if (buffer.length > MAX_STDIN_LINE_CHARS) {
        sendLog("error", "Host message exceeded maximum line size.");
        buffer = "";
      }
      break;
    }
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    void handleMessage(parsed);
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
process.stdin.resume();

process.on("uncaughtException", (error) => {
  sendLog("error", "Uncaught exception: " + errorMessage(error));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  sendLog("error", "Unhandled rejection: " + errorMessage(reason));
  process.exit(1);
});
`.trim();
