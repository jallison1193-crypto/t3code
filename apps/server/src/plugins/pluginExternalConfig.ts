// @effect-diagnostics nodeBuiltinImport:off - plugin external config scanning uses synchronous Node fs/path/crypto APIs matching PluginRegistry.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type InstalledPluginAgentSummary,
  type InstalledPluginHookSummary,
  PLUGIN_AGENT_MAX_BYTES,
  PLUGIN_HOOKS_JSON_MAX_BYTES,
  PLUGIN_MAX_AGENTS,
  PLUGIN_MAX_MCP_SERVERS,
  PLUGIN_MCP_JSON_MAX_BYTES,
  PluginAgentEffortLevel,
  PluginHookHandler,
  type PluginHookMatcherGroup,
  PluginHooksConfig,
  PluginId,
  type PluginMcpServerConfig,
  PluginMcpServerName,
  PluginMcpServerRemoteConfig,
  PluginMcpServerStdioConfig,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { readThemeFileGuarded } from "../environmentTheme.ts";
import { parseYamlFrontmatter } from "./pluginSlashCommand.ts";

export const PLUGIN_MCP_FILE = ".mcp.json";
const PLUGIN_HOOKS_DIR = "hooks";
export const PLUGIN_HOOKS_FILE = "hooks/hooks.json";
export const PLUGIN_AGENTS_DIR = "agents";
const PLUGINS_DATA_DIR_NAME = "plugins-data";

const PLUGIN_TOOL_NAME_MAX_LENGTH = 50;
const PLUGIN_TOOL_PLUGIN_PREFIX_LENGTH = 20;
const PLUGIN_TOOL_HASH_LENGTH = 16;
const DISPLAY_TARGET_MAX_CHARS = 240;

const UNSUPPORTED_MCP_PLACEHOLDER_PATTERN =
  /\$\{(?:CLAUDE_PROJECT_DIR(?:[:}][^}]*)?|user_config\.[^}]+)\}/;
const MCP_VAR_EXPANSION_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const HOOK_PATH_VAR_PATTERN = /\$\{(CLAUDE_PLUGIN_ROOT|T3_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g;

const ALLOWED_BASE_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);

const isPluginId = Schema.is(PluginId);
const isMcpServerName = Schema.is(PluginMcpServerName);
const isEffortLevel = Schema.is(PluginAgentEffortLevel);
const decodeStdioServerExit = Schema.decodeUnknownExit(PluginMcpServerStdioConfig);
const decodeRemoteServerExit = Schema.decodeUnknownExit(PluginMcpServerRemoteConfig);
const decodeHooksEventMapExit = Schema.decodeUnknownExit(PluginHooksConfig);

export interface RawExternalTextFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface ScannedPluginMcpServer {
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse" | "ws";
  readonly target: string;
  readonly rawConfig: Readonly<Record<string, unknown>>;
  readonly writeConfig?: PluginMcpServerConfig;
  readonly runnable?:
    | {
        readonly kind: "stdio";
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly env: Readonly<Record<string, string>>;
        readonly timeoutMs?: number;
      }
    | {
        readonly kind: "http";
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
        readonly timeoutMs?: number;
      };
  readonly notRunnableReason?: string;
}

export interface ScannedPluginAgent {
  readonly name: PluginId;
  readonly description: string;
  readonly prompt: string;
  readonly tools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly effort?: PluginAgentEffortLevel | number;
  readonly maxTurns?: number;
  readonly relativePath: string;
}

export interface PluginAgentWriteContent {
  readonly name: PluginId;
  readonly description: string;
  readonly tools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly effort?: PluginAgentEffortLevel | number;
  readonly maxTurns?: number;
  readonly body: string;
}

export interface ScannedExternalParts {
  readonly mcpServers: ReadonlyArray<ScannedPluginMcpServer>;
  readonly hooks?: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>;
  readonly hookSummaries: ReadonlyArray<InstalledPluginHookSummary>;
  readonly agents: ReadonlyArray<ScannedPluginAgent>;
  readonly agentSummaries: ReadonlyArray<InstalledPluginAgentSummary>;
  readonly externalPowersHash?: string;
  readonly hasRunnableExternal: boolean;
  readonly rawFiles: ReadonlyArray<RawExternalTextFile>;
  readonly partProblems: ReadonlyArray<string>;
  readonly hasInlineManifestMcp: boolean;
  readonly hasInlineManifestHooks: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value);

const lstatOrNull = (targetPath: string): NodeFS.Stats | null => {
  try {
    return NodeFS.lstatSync(targetPath);
  } catch {
    return null;
  }
};

const realpathOrNull = (targetPath: string): string | null => {
  try {
    return NodeFS.realpathSync(targetPath);
  } catch {
    return null;
  }
};

const isInsideDirectory = (
  rootPath: string,
  candidatePath: string,
  allowEqual: boolean,
): boolean => {
  const relative = NodePath.relative(rootPath, candidatePath);
  if (relative === "") return allowEqual;
  return !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const truncateDisplay = (text: string, maxChars = DISPLAY_TARGET_MAX_CHARS): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1)}…`;
};

const normalizeRelativePosixPath = (relativePath: string): string | null => {
  if (
    !relativePath.startsWith("./") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    return null;
  }
  const normalized = NodePath.posix.normalize(relativePath.slice(2));
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.startsWith("..") ||
    normalized.startsWith("/")
  ) {
    return null;
  }
  return normalized;
};

const readGuardedJsonFile = (
  folderPath: string,
  pluginRootReal: string,
  relativePosixPath: string,
  kindLabel: string,
  maxBytes: number,
  maxKbLabel: string,
):
  | { readonly ok: true; readonly content: string; readonly parsed: unknown }
  | { readonly ok: false; readonly problem: string } => {
  const fullPath = NodePath.resolve(folderPath, ...relativePosixPath.split("/"));
  const resolvedFolder = NodePath.resolve(folderPath);
  if (!isInsideDirectory(resolvedFolder, fullPath, false)) {
    return {
      ok: false,
      problem: `${kindLabel} "${relativePosixPath}" must stay inside the plugin folder.`,
    };
  }
  const stat = lstatOrNull(fullPath);
  if (stat === null) {
    return { ok: false, problem: `${kindLabel} "${relativePosixPath}" was not found.` };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, problem: `${kindLabel} "${relativePosixPath}" cannot be a symlink.` };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      problem: `${kindLabel} "${relativePosixPath}" is not a regular file.`,
    };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      problem: `${kindLabel} "${relativePosixPath}" exceeds the ${maxKbLabel} limit.`,
    };
  }
  const dirReal = realpathOrNull(NodePath.dirname(fullPath));
  if (dirReal === null || !isInsideDirectory(pluginRootReal, dirReal, true)) {
    return {
      ok: false,
      problem: `${kindLabel} "${relativePosixPath}" must stay inside the plugin folder.`,
    };
  }
  const content = readThemeFileGuarded(fullPath, maxBytes);
  if (content === null) {
    return { ok: false, problem: `${kindLabel} "${relativePosixPath}" could not be read.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, problem: `${kindLabel} "${relativePosixPath}" is not valid JSON.` };
  }
  return { ok: true, content, parsed };
};

export function pluginDataDirFor(stateDir: string, pluginId: string): string {
  return NodePath.join(stateDir, PLUGINS_DATA_DIR_NAME, pluginId);
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      const entry = value[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeJsonValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

export function computePluginExternalPowersHash(
  mcpServers: ReadonlyArray<Pick<ScannedPluginMcpServer, "name" | "rawConfig">>,
  hooks: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>> | undefined,
): string | undefined {
  const hasMcp = mcpServers.length > 0;
  const hasHooks =
    hooks !== undefined &&
    Object.values(hooks).some((groups) => groups.some((group) => group.hooks.length > 0));
  if (!hasMcp && !hasHooks) {
    return undefined;
  }
  const normalizedMcp: Record<string, unknown> = {};
  for (const server of [...mcpServers].sort((a, b) => a.name.localeCompare(b.name))) {
    normalizedMcp[server.name] = canonicalizeJsonValue(server.rawConfig);
  }
  const normalizedHooks = hooks === undefined ? {} : canonicalizeJsonValue(hooks);
  const canonical = JSON.stringify({
    hooks: normalizedHooks,
    mcpServers: normalizedMcp,
  });
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export function computePluginMcpServerConfigKey(
  server: ScannedPluginMcpServer,
  pluginRootReal: string,
  pluginDataDir: string,
): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        config: canonicalizeJsonValue(server.rawConfig),
        pluginRootReal,
        pluginDataDir,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function pluginMcpToolName(pluginId: string, serverName: string, toolName: string): string {
  const sanitize = (segment: string) => segment.replace(/[^A-Za-z0-9_-]/g, "_");
  const safePlugin = sanitize(pluginId);
  const safeServer = sanitize(serverName);
  const safeTool = sanitize(toolName);
  const full = `plugin_${safePlugin}_${safeServer}__${safeTool}`;
  if (full.length <= PLUGIN_TOOL_NAME_MAX_LENGTH) {
    return full;
  }
  const digest = NodeCrypto.createHash("sha256")
    .update(pluginId)
    .update("\0")
    .update(serverName)
    .update("\0")
    .update(toolName)
    .digest("hex")
    .slice(0, PLUGIN_TOOL_HASH_LENGTH);
  return `plugin_${safePlugin.slice(0, PLUGIN_TOOL_PLUGIN_PREFIX_LENGTH)}__${digest}`;
}

export function expandPluginMcpString(
  raw: string,
  context: {
    readonly pluginRoot: string;
    readonly pluginDataDir: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): string {
  return raw.replace(
    MCP_VAR_EXPANSION_PATTERN,
    (match, name: string, defaultValue: string | undefined) => {
      if (name === "CLAUDE_PLUGIN_ROOT" || name === "T3_PLUGIN_ROOT") {
        return context.pluginRoot;
      }
      if (name === "CLAUDE_PLUGIN_DATA") {
        return context.pluginDataDir;
      }
      const value = Object.hasOwn(context.env, name) ? context.env[name] : undefined;
      if (defaultValue !== undefined) {
        return value !== undefined && value !== "" ? value : defaultValue;
      }
      return value !== undefined ? value : match;
    },
  );
}

export function buildPluginMcpProcessEnv(input: {
  readonly hostEnv: NodeJS.ProcessEnv;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly declaredEnv?: Readonly<Record<string, string>> | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.hostEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith("T3CODE_")) continue;
    if (ALLOWED_BASE_ENV_KEYS.has(upper)) {
      env[key] = value;
    }
  }
  env.CLAUDE_PLUGIN_ROOT = input.pluginRoot;
  env.T3_PLUGIN_ROOT = input.pluginRoot;
  env.CLAUDE_PLUGIN_DATA = input.pluginDataDir;

  if (input.declaredEnv !== undefined) {
    for (const [key, rawValue] of Object.entries(input.declaredEnv)) {
      if (key.toUpperCase().startsWith("T3CODE_")) continue;
      env[key] = expandPluginMcpString(rawValue, {
        pluginRoot: input.pluginRoot,
        pluginDataDir: input.pluginDataDir,
        env: input.hostEnv,
      });
    }
  }
  return env;
}

const substituteHookPathVars = (
  value: string,
  context: { readonly pluginRoot: string; readonly pluginDataDir: string },
): string =>
  value.replace(HOOK_PATH_VAR_PATTERN, (_match, name: string) =>
    name === "CLAUDE_PLUGIN_DATA" ? context.pluginDataDir : context.pluginRoot,
  );

const expandHookJsonValue = (
  value: unknown,
  context: { readonly pluginRoot: string; readonly pluginDataDir: string },
): unknown => {
  if (typeof value === "string") {
    return substituteHookPathVars(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandHookJsonValue(item, context));
  }
  if (isPlainObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = expandHookJsonValue(entry, context);
    }
    return next;
  }
  return value;
};

const expandHookHandler = (
  handler: PluginHookHandler,
  context: { readonly pluginRoot: string; readonly pluginDataDir: string },
): PluginHookHandler => {
  const sub = (value: string) => substituteHookPathVars(value, context);
  switch (handler.type) {
    case "command":
      return {
        ...handler,
        command: sub(handler.command),
        ...(handler.args !== undefined ? { args: handler.args.map(sub) } : {}),
        ...(handler.if !== undefined ? { if: sub(handler.if) } : {}),
        ...(handler.statusMessage !== undefined
          ? { statusMessage: sub(handler.statusMessage) }
          : {}),
      };
    case "http":
      return {
        ...handler,
        url: sub(handler.url),
        ...(handler.headers !== undefined
          ? {
              headers: Object.fromEntries(
                Object.entries(handler.headers).map(([key, val]) => [key, sub(val)]),
              ),
            }
          : {}),
        ...(handler.if !== undefined ? { if: sub(handler.if) } : {}),
        ...(handler.statusMessage !== undefined
          ? { statusMessage: sub(handler.statusMessage) }
          : {}),
      };
    case "mcp_tool":
      return {
        ...handler,
        server: sub(handler.server),
        tool: sub(handler.tool),
        ...(handler.input !== undefined
          ? {
              input: Object.fromEntries(
                Object.entries(handler.input).map(([key, val]) => [
                  key,
                  expandHookJsonValue(val, context),
                ]),
              ),
            }
          : {}),
        ...(handler.if !== undefined ? { if: sub(handler.if) } : {}),
        ...(handler.statusMessage !== undefined
          ? { statusMessage: sub(handler.statusMessage) }
          : {}),
      };
    case "prompt":
      return {
        ...handler,
        prompt: sub(handler.prompt),
        ...(handler.if !== undefined ? { if: sub(handler.if) } : {}),
        ...(handler.statusMessage !== undefined
          ? { statusMessage: sub(handler.statusMessage) }
          : {}),
      };
    case "agent":
      return {
        ...handler,
        prompt: sub(handler.prompt),
        ...(handler.if !== undefined ? { if: sub(handler.if) } : {}),
        ...(handler.statusMessage !== undefined
          ? { statusMessage: sub(handler.statusMessage) }
          : {}),
      };
  }
};

export function expandPluginHooksEventMap(
  hooks: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>,
  context: { readonly pluginRoot: string; readonly pluginDataDir: string },
): Record<string, ReadonlyArray<PluginHookMatcherGroup>> {
  const expanded: Record<string, ReadonlyArray<PluginHookMatcherGroup>> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (groups.length === 0) continue;
    expanded[event] = groups.map((group) => ({
      ...(group.matcher !== undefined
        ? { matcher: substituteHookPathVars(group.matcher, context) }
        : {}),
      hooks: group.hooks.map((handler) => expandHookHandler(handler, context)),
    }));
  }
  return expanded;
}

const isMcpPackageUrl = (rawUrl: string): boolean => {
  const withoutQuery = rawUrl.split(/[?#]/, 1)[0] ?? rawUrl;
  return /\.(?:mcpb|dxt)$/i.test(withoutQuery.trim());
};

const hasUnsupportedMcpPlaceholder = (values: ReadonlyArray<string>): boolean =>
  values.some((value) => UNSUPPORTED_MCP_PLACEHOLDER_PATTERN.test(value));

const isValidHttpUrlScheme = (rawUrl: string): boolean => {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("${")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return /^https?:\/\//i.test(trimmed);
  }
};

const extractMcpServerMap = (
  parsed: unknown,
): { readonly ok: true; readonly entries: Record<string, unknown> } | { readonly ok: false } => {
  if (!isPlainObject(parsed)) {
    return { ok: false };
  }
  if (Object.hasOwn(parsed, "mcpServers")) {
    const inner = parsed.mcpServers;
    if (!isPlainObject(inner)) {
      return { ok: false };
    }
    const innerLooksLikeSingleServer =
      typeof inner.command === "string" || typeof inner.url === "string";
    if (!innerLooksLikeSingleServer) {
      return { ok: true, entries: inner };
    }
  }
  return { ok: true, entries: parsed };
};

const parseOneMcpServer = (
  name: string,
  raw: unknown,
):
  | { readonly ok: true; readonly server: ScannedPluginMcpServer }
  | { readonly ok: false; readonly problem: string } => {
  if (!isMcpServerName(name)) {
    return {
      ok: false,
      problem: `MCP server name "${name}" must match ^[A-Za-z0-9_-]{1,40}$.`,
    };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, problem: `MCP server "${name}" must be an object.` };
  }

  const rawType = raw.type;
  if (rawType === "ws") {
    const target =
      typeof raw.url === "string" && raw.url.trim().length > 0 ? truncateDisplay(raw.url) : name;
    return {
      ok: true,
      server: {
        name,
        transport: "ws",
        target,
        rawConfig: raw,
        notRunnableReason: "WebSocket (ws) MCP servers are not supported.",
      },
    };
  }

  const hasUrl = Object.hasOwn(raw, "url") && raw.url !== undefined;
  const hasCommand = Object.hasOwn(raw, "command") && raw.command !== undefined;

  if (hasUrl && hasCommand) {
    return {
      ok: false,
      problem: `MCP server "${name}" cannot set both "command" and "url".`,
    };
  }

  if (hasUrl) {
    if (rawType === undefined) {
      return {
        ok: false,
        problem: `MCP server "${name}" with "url" must declare "type" ("http", "streamable-http", or "sse").`,
      };
    }
    const decoded = decodeRemoteServerExit({
      type: raw.type,
      url: raw.url,
      ...(raw.headers !== undefined ? { headers: raw.headers } : {}),
      ...(raw.timeout !== undefined ? { timeout: raw.timeout } : {}),
    });
    if (Exit.isFailure(decoded)) {
      return {
        ok: false,
        problem: `MCP server "${name}" has an invalid remote server configuration.`,
      };
    }
    const cfg = decoded.value;
    const normalizedTransport = cfg.type === "sse" ? "sse" : "http";
    const target = truncateDisplay(cfg.url);

    let notRunnableReason: string | undefined;
    if (Object.hasOwn(raw, "oauth") && raw.oauth !== undefined) {
      notRunnableReason = "OAuth is not supported for plugin MCP servers yet.";
    } else if (Object.hasOwn(raw, "headersHelper") && raw.headersHelper !== undefined) {
      notRunnableReason = "headersHelper is not supported for plugin MCP servers yet.";
    } else if (isMcpPackageUrl(cfg.url)) {
      notRunnableReason = "MCPB and DXT package URLs are not supported.";
    } else if (hasUnsupportedMcpPlaceholder([cfg.url, ...Object.values(cfg.headers ?? {})])) {
      notRunnableReason =
        "Uses ${CLAUDE_PROJECT_DIR} or ${user_config.*} which are not supported for shared plugin MCP servers.";
    } else if (!isValidHttpUrlScheme(cfg.url)) {
      notRunnableReason = "Remote MCP server URL must use http or https.";
    }

    return {
      ok: true,
      server: {
        name,
        transport: normalizedTransport,
        target,
        rawConfig: raw,
        writeConfig: cfg,
        ...(notRunnableReason !== undefined
          ? { notRunnableReason }
          : {
              runnable: {
                kind: "http",
                url: cfg.url,
                headers: cfg.headers ?? {},
                ...(cfg.timeout !== undefined ? { timeoutMs: cfg.timeout } : {}),
              },
            }),
      },
    };
  }

  if (hasCommand) {
    const decoded = decodeStdioServerExit({
      ...(raw.type !== undefined ? { type: raw.type } : {}),
      command: raw.command,
      ...(raw.args !== undefined ? { args: raw.args } : {}),
      ...(raw.env !== undefined ? { env: raw.env } : {}),
      ...(raw.timeout !== undefined ? { timeout: raw.timeout } : {}),
    });
    if (Exit.isFailure(decoded)) {
      return {
        ok: false,
        problem: `MCP server "${name}" has an invalid stdio server configuration.`,
      };
    }
    const cfg = decoded.value;
    const args = cfg.args ?? [];
    const target = truncateDisplay([cfg.command, ...args].join(" "));

    let notRunnableReason: string | undefined;
    if (Object.hasOwn(raw, "oauth") && raw.oauth !== undefined) {
      notRunnableReason = "OAuth is not supported for plugin MCP servers yet.";
    } else if (Object.hasOwn(raw, "headersHelper") && raw.headersHelper !== undefined) {
      notRunnableReason = "headersHelper is not supported for plugin MCP servers yet.";
    } else if (
      hasUnsupportedMcpPlaceholder([cfg.command, ...args, ...Object.values(cfg.env ?? {})])
    ) {
      notRunnableReason =
        "Uses ${CLAUDE_PROJECT_DIR} or ${user_config.*} which are not supported for shared plugin MCP servers.";
    }

    return {
      ok: true,
      server: {
        name,
        transport: "stdio",
        target,
        rawConfig: raw,
        writeConfig: cfg,
        ...(notRunnableReason !== undefined
          ? { notRunnableReason }
          : {
              runnable: {
                kind: "stdio",
                command: cfg.command,
                args,
                env: cfg.env ?? {},
                ...(cfg.timeout !== undefined ? { timeoutMs: cfg.timeout } : {}),
              },
            }),
      },
    };
  }

  return {
    ok: false,
    problem: `MCP server "${name}" must specify either "command" or "type" + "url".`,
  };
};

const scanPluginMcpPart = (
  folderPath: string,
  pluginRootReal: string,
  manifestMcpServers: unknown,
): {
  readonly servers: ReadonlyArray<ScannedPluginMcpServer>;
  readonly rawFiles: ReadonlyArray<RawExternalTextFile>;
  readonly problem?: string;
  readonly hasInline: boolean;
} => {
  const rawFilesByPath = new Map<string, string>();
  const mergedEntries = new Map<string, unknown>();
  let hasInline = false;

  const loadJsonSource = (
    relativePosixPath: string,
  ): { readonly ok: true } | { readonly ok: false; readonly problem: string } => {
    if (rawFilesByPath.has(relativePosixPath)) return { ok: true };
    const read = readGuardedJsonFile(
      folderPath,
      pluginRootReal,
      relativePosixPath,
      "MCP config",
      PLUGIN_MCP_JSON_MAX_BYTES,
      "64 KB",
    );
    if (!read.ok) return read;
    rawFilesByPath.set(relativePosixPath, read.content);
    const extracted = extractMcpServerMap(read.parsed);
    if (!extracted.ok) {
      return { ok: false, problem: `MCP config "${relativePosixPath}" must be a JSON object.` };
    }
    for (const [name, cfg] of Object.entries(extracted.entries)) {
      mergedEntries.set(name, cfg);
    }
    return { ok: true };
  };

  if (lstatOrNull(NodePath.join(folderPath, PLUGIN_MCP_FILE)) !== null) {
    const res = loadJsonSource(PLUGIN_MCP_FILE);
    if (!res.ok) {
      return {
        servers: [],
        rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
          relativePath,
          content,
        })),
        problem: res.problem,
        hasInline,
      };
    }
  }

  if (manifestMcpServers !== undefined) {
    if (typeof manifestMcpServers === "string") {
      const normalized = normalizeRelativePosixPath(manifestMcpServers);
      if (normalized === null || !normalized.endsWith(".json")) {
        return {
          servers: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem:
            'Manifest "mcpServers" path must start with "./", end with ".json", and stay inside the plugin folder.',
          hasInline,
        };
      }
      const res = loadJsonSource(normalized);
      if (!res.ok) {
        return {
          servers: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem: res.problem,
          hasInline,
        };
      }
    } else if (isPlainObject(manifestMcpServers)) {
      hasInline = true;
      const serializedBytes = Buffer.byteLength(JSON.stringify(manifestMcpServers), "utf8");
      if (serializedBytes > PLUGIN_MCP_JSON_MAX_BYTES) {
        return {
          servers: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem: 'Manifest "mcpServers" exceeds the 64 KB limit.',
          hasInline,
        };
      }
      const extracted = extractMcpServerMap(manifestMcpServers);
      if (!extracted.ok) {
        return {
          servers: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem: 'Manifest "mcpServers" must be an object or relative JSON path.',
          hasInline,
        };
      }
      for (const [name, cfg] of Object.entries(extracted.entries)) {
        mergedEntries.set(name, cfg);
      }
    } else {
      return {
        servers: [],
        rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
          relativePath,
          content,
        })),
        problem: 'Manifest "mcpServers" must be an object or relative JSON path.',
        hasInline,
      };
    }
  }

  const rawFiles = [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
    relativePath,
    content,
  }));

  if (mergedEntries.size > PLUGIN_MAX_MCP_SERVERS) {
    return {
      servers: [],
      rawFiles,
      problem: `Plugin exceeds the ${PLUGIN_MAX_MCP_SERVERS} MCP servers limit.`,
      hasInline,
    };
  }

  const servers: Array<ScannedPluginMcpServer> = [];
  for (const name of [...mergedEntries.keys()].toSorted()) {
    const parsed = parseOneMcpServer(name, mergedEntries.get(name));
    if (!parsed.ok) {
      return { servers: [], rawFiles, problem: parsed.problem, hasInline };
    }
    servers.push(parsed.server);
  }

  return { servers, rawFiles, hasInline };
};

const summarizeHookHandler = (
  event: string,
  matcher: string | undefined,
  handler: PluginHookHandler,
): InstalledPluginHookSummary => {
  let target: string;
  switch (handler.type) {
    case "command":
      target = truncateDisplay(
        handler.args !== undefined && handler.args.length > 0
          ? `${handler.command} ${handler.args.join(" ")}`
          : handler.command,
      );
      break;
    case "http":
      target = truncateDisplay(handler.url);
      break;
    case "mcp_tool":
      target = truncateDisplay(`${handler.server}/${handler.tool}`);
      break;
    case "prompt":
    case "agent":
      target = truncateDisplay(handler.prompt, 120);
      break;
  }
  return {
    event,
    ...(matcher !== undefined && matcher.trim().length > 0 ? { matcher: matcher.trim() } : {}),
    type: handler.type,
    target,
  };
};

const extractHooksFileEventMap = (
  parsed: unknown,
  label: string,
):
  | {
      readonly ok: true;
      readonly hooks: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>;
    }
  | { readonly ok: false; readonly problem: string } => {
  if (!isPlainObject(parsed)) {
    return { ok: false, problem: `Hooks config "${label}" must be a JSON object.` };
  }
  if (parsed.description !== undefined && typeof parsed.description !== "string") {
    return { ok: false, problem: `Hooks config "${label}" has an invalid "description" field.` };
  }
  if (!Object.hasOwn(parsed, "hooks") || parsed.hooks === undefined) {
    const otherKeys = Object.keys(parsed).filter(
      (key) => key !== "description" && key !== "$schema",
    );
    if (otherKeys.length === 0) {
      return { ok: true, hooks: {} };
    }
    return {
      ok: false,
      problem: `Hooks file "${label}" must wrap events under a "hooks" object.`,
    };
  }
  const decoded = decodeHooksEventMapExit(parsed.hooks);
  if (Exit.isFailure(decoded)) {
    return { ok: false, problem: `Hooks config "${label}" has invalid hook entries.` };
  }
  return { ok: true, hooks: decoded.value };
};

const scanPluginHooksPart = (
  folderPath: string,
  pluginRootReal: string,
  manifestHooks: unknown,
): {
  readonly hooks?: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>;
  readonly summaries: ReadonlyArray<InstalledPluginHookSummary>;
  readonly rawFiles: ReadonlyArray<RawExternalTextFile>;
  readonly problem?: string;
  readonly hasInline: boolean;
} => {
  const rawFilesByPath = new Map<string, string>();
  const mergedEvents = new Map<string, Array<PluginHookMatcherGroup>>();
  let hasInline = false;

  const appendEvents = (
    eventMap: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>,
  ) => {
    for (const [event, groups] of Object.entries(eventMap)) {
      const nonEmpty = groups.filter((group) => group.hooks.length > 0);
      if (nonEmpty.length === 0) continue;
      const existing = mergedEvents.get(event) ?? [];
      mergedEvents.set(event, [...existing, ...nonEmpty]);
    }
  };

  const loadHooksFile = (
    relativePosixPath: string,
  ): { readonly ok: true } | { readonly ok: false; readonly problem: string } => {
    if (rawFilesByPath.has(relativePosixPath)) return { ok: true };
    const read = readGuardedJsonFile(
      folderPath,
      pluginRootReal,
      relativePosixPath,
      "Hooks config",
      PLUGIN_HOOKS_JSON_MAX_BYTES,
      "64 KB",
    );
    if (!read.ok) return read;
    rawFilesByPath.set(relativePosixPath, read.content);
    const extracted = extractHooksFileEventMap(read.parsed, relativePosixPath);
    if (!extracted.ok) return extracted;
    appendEvents(extracted.hooks);
    return { ok: true };
  };

  const defaultHooksPath = NodePath.join(folderPath, PLUGIN_HOOKS_DIR, "hooks.json");
  const hooksDirStat = lstatOrNull(NodePath.join(folderPath, PLUGIN_HOOKS_DIR));
  if (hooksDirStat !== null && hooksDirStat.isSymbolicLink()) {
    return {
      summaries: [],
      rawFiles: [],
      problem: `Directory "${PLUGIN_HOOKS_DIR}" cannot be a symlink.`,
      hasInline,
    };
  }
  if (lstatOrNull(defaultHooksPath) !== null) {
    const res = loadHooksFile(PLUGIN_HOOKS_FILE);
    if (!res.ok) {
      return {
        summaries: [],
        rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
          relativePath,
          content,
        })),
        problem: res.problem,
        hasInline,
      };
    }
  }

  if (manifestHooks !== undefined) {
    if (typeof manifestHooks === "string") {
      const normalized = normalizeRelativePosixPath(manifestHooks);
      if (normalized === null || !normalized.endsWith(".json")) {
        return {
          summaries: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem:
            'Manifest "hooks" path must start with "./", end with ".json", and stay inside the plugin folder.',
          hasInline,
        };
      }
      const res = loadHooksFile(normalized);
      if (!res.ok) {
        return {
          summaries: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem: res.problem,
          hasInline,
        };
      }
    } else if (isPlainObject(manifestHooks)) {
      hasInline = true;
      const serializedBytes = Buffer.byteLength(JSON.stringify(manifestHooks), "utf8");
      if (serializedBytes > PLUGIN_HOOKS_JSON_MAX_BYTES) {
        return {
          summaries: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem: 'Manifest "hooks" exceeds the 64 KB limit.',
          hasInline,
        };
      }
      const decoded = decodeHooksEventMapExit(manifestHooks);
      if (Exit.isFailure(decoded)) {
        return {
          summaries: [],
          rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
          problem: 'Manifest "hooks" has invalid hook entries.',
          hasInline,
        };
      }
      appendEvents(decoded.value);
    } else {
      return {
        summaries: [],
        rawFiles: [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
          relativePath,
          content,
        })),
        problem: 'Manifest "hooks" must be an event map object or relative JSON path.',
        hasInline,
      };
    }
  }

  const rawFiles = [...rawFilesByPath.entries()].map(([relativePath, content]) => ({
    relativePath,
    content,
  }));

  if (mergedEvents.size === 0) {
    return { summaries: [], rawFiles, hasInline };
  }

  const hooks: Record<string, ReadonlyArray<PluginHookMatcherGroup>> = {};
  const summaries: Array<InstalledPluginHookSummary> = [];
  for (const event of [...mergedEvents.keys()].toSorted()) {
    const groups = mergedEvents.get(event)!;
    hooks[event] = groups;
    for (const group of groups) {
      for (const handler of group.hooks) {
        summaries.push(summarizeHookHandler(event, group.matcher, handler));
      }
    }
  }

  return { hooks, summaries, rawFiles, hasInline };
};

const parseToolNameList = (value: unknown): ReadonlyArray<string> | undefined => {
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
};

export function parsePluginAgentMarkdown(
  contents: string,
  fallbackName: string,
):
  | {
      readonly ok: true;
      readonly name: PluginId;
      readonly description: string;
      readonly prompt: string;
      readonly tools?: ReadonlyArray<string>;
      readonly disallowedTools?: ReadonlyArray<string>;
      readonly model?: string;
      readonly effort?: PluginAgentEffortLevel | number;
      readonly maxTurns?: number;
    }
  | { readonly ok: false; readonly problem: string } {
  const fm = parseYamlFrontmatter(contents);
  if (!fm.ok) return fm;
  const data = fm.data;
  const rawName =
    typeof data.name === "string" && data.name.trim().length > 0 ? data.name.trim() : fallbackName;
  if (!isPluginId(rawName)) {
    return { ok: false, problem: `Agent name "${rawName}" is not a valid plugin id.` };
  }
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (description.length === 0) {
    return { ok: false, problem: `Agent "${rawName}" is missing a required description.` };
  }
  const tools = parseToolNameList(data.tools);
  const disallowedTools = parseToolNameList(data.disallowedTools);
  const model =
    typeof data.model === "string" && data.model.trim().length > 0 ? data.model.trim() : undefined;
  let effort: PluginAgentEffortLevel | number | undefined;
  if (typeof data.effort === "number" && Number.isInteger(data.effort) && data.effort > 0) {
    effort = data.effort;
  } else if (typeof data.effort === "string") {
    const trimmed = data.effort.trim().toLowerCase();
    if (isEffortLevel(trimmed)) {
      effort = trimmed;
    }
  }
  const maxTurns =
    typeof data.maxTurns === "number" && Number.isInteger(data.maxTurns) && data.maxTurns > 0
      ? data.maxTurns
      : undefined;

  return {
    ok: true,
    name: rawName,
    description,
    prompt: fm.body,
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

export function formatPluginAgentMarkdown(agent: PluginAgentWriteContent): string {
  const lines = [`name: ${agent.name}`, `description: ${JSON.stringify(agent.description.trim())}`];
  if (agent.tools !== undefined && agent.tools.length > 0) {
    lines.push(`tools: ${JSON.stringify(agent.tools)}`);
  }
  if (agent.disallowedTools !== undefined && agent.disallowedTools.length > 0) {
    lines.push(`disallowedTools: ${JSON.stringify(agent.disallowedTools)}`);
  }
  const model = agent.model?.trim();
  if (model) {
    lines.push(`model: ${JSON.stringify(model)}`);
  }
  if (agent.effort !== undefined) {
    lines.push(`effort: ${agent.effort}`);
  }
  if (agent.maxTurns !== undefined) {
    lines.push(`maxTurns: ${agent.maxTurns}`);
  }
  const body = agent.body.replace(/^\r?\n+/, "").trimEnd();
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

const scanPluginAgentsPart = (
  folderPath: string,
  pluginRootReal: string,
): {
  readonly agents: ReadonlyArray<ScannedPluginAgent>;
  readonly rawFiles: ReadonlyArray<RawExternalTextFile>;
  readonly problems: ReadonlyArray<string>;
} => {
  const agentsDir = NodePath.join(folderPath, PLUGIN_AGENTS_DIR);
  const dirStat = lstatOrNull(agentsDir);
  if (dirStat === null) {
    return { agents: [], rawFiles: [], problems: [] };
  }
  if (dirStat.isSymbolicLink()) {
    return {
      agents: [],
      rawFiles: [],
      problems: [`Directory "${PLUGIN_AGENTS_DIR}" cannot be a symlink.`],
    };
  }
  if (!dirStat.isDirectory()) {
    return { agents: [], rawFiles: [], problems: [] };
  }

  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(agentsDir).toSorted();
  } catch {
    return {
      agents: [],
      rawFiles: [],
      problems: [`Directory "${PLUGIN_AGENTS_DIR}" could not be read.`],
    };
  }

  const mdFiles: Array<{ readonly fileName: string; readonly fullPath: string }> = [];
  for (const entry of entries) {
    if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
    const fullPath = NodePath.join(agentsDir, entry);
    const stat = lstatOrNull(fullPath);
    if (stat === null || stat.isDirectory()) continue;
    mdFiles.push({ fileName: entry, fullPath });
  }

  if (mdFiles.length > PLUGIN_MAX_AGENTS) {
    return {
      agents: [],
      rawFiles: [],
      problems: [`Plugin exceeds the ${PLUGIN_MAX_AGENTS} agents limit.`],
    };
  }

  const agents: Array<ScannedPluginAgent> = [];
  const rawFiles: Array<RawExternalTextFile> = [];
  const problems: Array<string> = [];
  const seenNames = new Set<string>();

  for (const { fileName, fullPath } of mdFiles) {
    const relativePath = `${PLUGIN_AGENTS_DIR}/${fileName}`;
    const stat = lstatOrNull(fullPath);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) {
      problems.push(`Agent file "${relativePath}" cannot be a symlink.`);
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > PLUGIN_AGENT_MAX_BYTES) {
      problems.push(`Agent file "${relativePath}" exceeds the 32 KB limit.`);
      continue;
    }
    const dirReal = realpathOrNull(NodePath.dirname(fullPath));
    if (dirReal === null || !isInsideDirectory(pluginRootReal, dirReal, true)) {
      problems.push(`Agent file "${relativePath}" must stay inside the plugin folder.`);
      continue;
    }
    const content = readThemeFileGuarded(fullPath, PLUGIN_AGENT_MAX_BYTES);
    if (content === null) {
      problems.push(`Agent file "${relativePath}" could not be read.`);
      continue;
    }
    rawFiles.push({ relativePath, content });
    const stem = fileName.slice(0, -3);
    const parsed = parsePluginAgentMarkdown(content, stem);
    if (!parsed.ok) {
      problems.push(`Invalid agent "${relativePath}": ${parsed.problem}`);
      continue;
    }
    if (seenNames.has(parsed.name)) {
      problems.push(`Duplicate agent name "${parsed.name}" in "${relativePath}".`);
      continue;
    }
    seenNames.add(parsed.name);
    agents.push({
      name: parsed.name,
      description: parsed.description,
      prompt: parsed.prompt,
      ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
      ...(parsed.disallowedTools !== undefined ? { disallowedTools: parsed.disallowedTools } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
      ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
      relativePath,
    });
  }

  return { agents, rawFiles, problems };
};

export function scanPluginExternalParts(input: {
  readonly folderPath: string;
  readonly pluginRootReal: string;
  readonly manifestMcpServers: unknown;
  readonly manifestHooks: unknown;
  readonly isRepo: boolean;
}): ScannedExternalParts {
  const rawFilesByPath = new Map<string, string>();
  const partProblems: Array<string> = [];

  const agentsPart = scanPluginAgentsPart(input.folderPath, input.pluginRootReal);
  for (const file of agentsPart.rawFiles) {
    rawFilesByPath.set(file.relativePath, file.content);
  }
  partProblems.push(...agentsPart.problems);

  let mcpServers: ReadonlyArray<ScannedPluginMcpServer> = [];
  let hooks: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>> | undefined;
  let hookSummaries: ReadonlyArray<InstalledPluginHookSummary> = [];
  let hasInlineManifestMcp = false;
  let hasInlineManifestHooks = false;

  if (!input.isRepo) {
    const mcpPart = scanPluginMcpPart(
      input.folderPath,
      input.pluginRootReal,
      input.manifestMcpServers,
    );
    mcpServers = mcpPart.servers;
    hasInlineManifestMcp = mcpPart.hasInline;
    for (const file of mcpPart.rawFiles) {
      rawFilesByPath.set(file.relativePath, file.content);
    }
    if (mcpPart.problem !== undefined) {
      partProblems.push(mcpPart.problem);
    }

    const hooksPart = scanPluginHooksPart(
      input.folderPath,
      input.pluginRootReal,
      input.manifestHooks,
    );
    hooks = hooksPart.hooks;
    hookSummaries = hooksPart.summaries;
    hasInlineManifestHooks = hooksPart.hasInline;
    for (const file of hooksPart.rawFiles) {
      rawFilesByPath.set(file.relativePath, file.content);
    }
    if (hooksPart.problem !== undefined) {
      partProblems.push(hooksPart.problem);
    }
  }

  const externalPowersHash = computePluginExternalPowersHash(mcpServers, hooks);
  const hasRunnableExternal =
    mcpServers.some((server) => server.runnable !== undefined) || hookSummaries.length > 0;

  return {
    mcpServers,
    ...(hooks !== undefined ? { hooks } : {}),
    hookSummaries,
    agents: agentsPart.agents,
    agentSummaries: agentsPart.agents.map(({ name, description }) => ({ name, description })),
    ...(externalPowersHash !== undefined ? { externalPowersHash } : {}),
    hasRunnableExternal,
    rawFiles: [...rawFilesByPath.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([relativePath, content]) => ({ relativePath, content })),
    partProblems,
    hasInlineManifestMcp,
    hasInlineManifestHooks,
  };
}

export function validateAndSerializePluginMcpWrite(
  mcpServers: Readonly<Record<string, PluginMcpServerConfig>>,
):
  | { readonly ok: true; readonly json: string | null }
  | { readonly ok: false; readonly problem: string } {
  const names = Object.keys(mcpServers);
  if (names.length === 0) {
    return { ok: true, json: null };
  }
  if (names.length > PLUGIN_MAX_MCP_SERVERS) {
    return {
      ok: false,
      problem: `Plugin can define at most ${PLUGIN_MAX_MCP_SERVERS} MCP servers.`,
    };
  }
  for (const name of names) {
    const parsed = parseOneMcpServer(name, mcpServers[name]);
    if (!parsed.ok) {
      return { ok: false, problem: parsed.problem };
    }
  }
  const json = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
  if (Buffer.byteLength(json, "utf8") > PLUGIN_MCP_JSON_MAX_BYTES) {
    return { ok: false, problem: "MCP server configuration exceeds the 64 KB limit." };
  }
  return { ok: true, json };
}

export function validateAndSerializePluginHooksWrite(
  hooks: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>,
):
  | { readonly ok: true; readonly json: string | null }
  | { readonly ok: false; readonly problem: string } {
  const decoded = decodeHooksEventMapExit(hooks);
  if (Exit.isFailure(decoded)) {
    return { ok: false, problem: "Hooks configuration has invalid event or handler entries." };
  }
  const cleaned: Record<string, ReadonlyArray<PluginHookMatcherGroup>> = {};
  for (const [event, groups] of Object.entries(decoded.value)) {
    const nonEmpty = groups.filter((group) => group.hooks.length > 0);
    if (nonEmpty.length > 0) {
      cleaned[event] = nonEmpty;
    }
  }
  if (Object.keys(cleaned).length === 0) {
    return { ok: true, json: null };
  }
  const json = `${JSON.stringify({ hooks: cleaned }, null, 2)}\n`;
  if (Buffer.byteLength(json, "utf8") > PLUGIN_HOOKS_JSON_MAX_BYTES) {
    return { ok: false, problem: "Hooks configuration exceeds the 64 KB limit." };
  }
  return { ok: true, json };
}

export function resolveManifestExternalJsonPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeRelativePosixPath(value);
  if (normalized === null || !normalized.endsWith(".json")) return null;
  return normalized;
}
