// @effect-diagnostics nodeBuiltinImport:off - worker folder validation, powers hashing, and runtime permission checks use synchronous Node fs/path/crypto APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PLUGIN_WORKER_LOG_MAX_BYTES, type PluginWorkerFolderAccess } from "@t3tools/contracts";

export const PLUGIN_WORKER_UNSUPPORTED_PROBLEM =
  "This T3 runtime can't lock plugin workers to folders.";

export const PLUGIN_WORKER_READ_MEMORY_MAX_FILES = 50;
export const PLUGIN_WORKER_READ_MEMORY_MAX_FILE_BYTES = 256 * 1024;
export const PLUGIN_WORKER_READ_MEMORY_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

interface PluginWorkerRuntimeCapabilities {
  readonly permissionSupported: boolean;
  readonly networkRestricted: boolean;
  readonly isElectron: boolean;
}

export function detectPluginWorkerRuntimeCapabilities(): PluginWorkerRuntimeCapabilities {
  const flags = process.allowedNodeEnvironmentFlags;
  const permissionSupported = flags.has("--permission");
  const networkRestricted = permissionSupported && flags.has("--allow-net");
  const isElectron =
    typeof process.versions.electron === "string" && process.versions.electron.length > 0;
  return { permissionSupported, networkRestricted, isElectron };
}

export function computePluginWorkerPowersHash(worker: {
  readonly everyMinutes?: number | undefined;
  readonly folders?:
    | ReadonlyArray<{
        readonly id: string;
        readonly access: PluginWorkerFolderAccess;
      }>
    | undefined;
  readonly network?: boolean | undefined;
}): string {
  const normalizedFolders = [...(worker.folders ?? [])]
    .map(({ id, access }) => ({ id, access }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const canonical = JSON.stringify({
    everyMinutes: worker.everyMinutes ?? null,
    folders: normalizedFolders,
    network: worker.network === true,
  });
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function isUncPath(targetPath: string): boolean {
  return targetPath.startsWith("\\\\") || targetPath.startsWith("//");
}

export function validateAndCanonicalizeWorkerFolderPath(
  rawPath: string,
  homeDirectory: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false } {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || /[\r\n\0]/.test(trimmed) || isUncPath(trimmed)) {
    return { ok: false };
  }

  let expanded = trimmed;
  if (trimmed === "~") {
    expanded = homeDirectory;
  } else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    expanded = NodePath.join(homeDirectory, trimmed.slice(2));
  }

  if (!NodePath.isAbsolute(expanded) || isUncPath(expanded)) {
    return { ok: false };
  }

  let realPath: string;
  let stat: NodeFS.Stats;
  try {
    realPath = NodeFS.realpathSync(expanded);
    if (isUncPath(realPath)) {
      return { ok: false };
    }
    stat = NodeFS.statSync(realPath);
  } catch {
    return { ok: false };
  }

  if (!stat.isDirectory()) {
    return { ok: false };
  }

  return { ok: true, path: realPath };
}

export function buildWorkerProcessEnv(
  hostEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isElectron: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const pathValue = hostEnv.PATH ?? hostEnv.Path;
  if (pathValue !== undefined) {
    env.PATH = pathValue;
  }
  if (platform === "win32") {
    const systemRoot = hostEnv.SystemRoot ?? hostEnv.SYSTEMROOT;
    if (systemRoot !== undefined) {
      env.SystemRoot = systemRoot;
    }
  }
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const) {
    const value = hostEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (isElectron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export function buildWorkerProcessArgs(input: {
  readonly pluginRootReal: string;
  readonly folders: ReadonlyArray<{
    readonly access: PluginWorkerFolderAccess;
    readonly realPath: string;
  }>;
  readonly network: boolean;
  readonly allowNetFlagSupported: boolean;
  readonly bootstrapSource: string;
}): ReadonlyArray<string> {
  const readPaths = new Set<string>([input.pluginRootReal]);
  const writePaths = new Set<string>();
  for (const folder of input.folders) {
    readPaths.add(folder.realPath);
    if (folder.access === "write") {
      writePaths.add(folder.realPath);
    }
  }

  const args: Array<string> = ["--permission", "--disallow-code-generation-from-strings"];
  for (const readPath of readPaths) {
    args.push(`--allow-fs-read=${readPath}`);
  }
  for (const writePath of writePaths) {
    args.push(`--allow-fs-write=${writePath}`);
  }
  if (input.network && input.allowNetFlagSupported) {
    args.push("--allow-net");
  }
  args.push("--input-type=module", "-e", input.bootstrapSource);
  return args;
}

const sliceUtf8Tail = (text: string, maxBytes: number): string => {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  let start = buf.length - maxBytes;
  // Advance past UTF-8 continuation bytes (10xxxxxx) so we never split a code point.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8");
};

export class PluginWorkerLogBuffer {
  readonly #maxBytes: number;
  #chunks: Array<{ readonly text: string; readonly bytes: number }> = [];
  #totalBytes = 0;
  #truncated = false;

  constructor(maxBytes: number = PLUGIN_WORKER_LOG_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  append(text: string): void {
    if (text.length === 0) return;
    let chunk = text;
    let bytes = Buffer.byteLength(chunk, "utf8");
    if (bytes > this.#maxBytes) {
      chunk = sliceUtf8Tail(chunk, this.#maxBytes);
      bytes = Buffer.byteLength(chunk, "utf8");
      this.#chunks = [{ text: chunk, bytes }];
      this.#totalBytes = bytes;
      this.#truncated = true;
      return;
    }
    this.#chunks.push({ text: chunk, bytes });
    this.#totalBytes += bytes;
    while (this.#totalBytes > this.#maxBytes && this.#chunks.length > 0) {
      const removed = this.#chunks.shift()!;
      this.#totalBytes -= removed.bytes;
      this.#truncated = true;
    }
  }

  read(): { readonly log: string; readonly truncated: boolean } {
    return {
      log: this.#chunks.map((chunk) => chunk.text).join(""),
      truncated: this.#truncated,
    };
  }
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}
