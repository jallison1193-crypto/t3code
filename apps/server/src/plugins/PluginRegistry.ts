// @effect-diagnostics nodeBuiltinImport:off - plugin scanning and revisions need lstat, realpath, utimes, crypto, and path containment checks alongside readThemeFileGuarded.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CLAUDE_PLUGIN_MANIFEST_DIR,
  type EnvironmentPlugin,
  type EnvironmentPluginCommand,
  type InstalledPlugin,
  type InstalledPluginMcpServer,
  type InstalledPluginPanel,
  type InstalledPluginWorker,
  type IsoDateTime,
  PLUGIN_AGENT_MAX_BYTES,
  PLUGIN_HOOKS_JSON_MAX_BYTES,
  PLUGIN_INSTRUCTIONS_MAX_BYTES,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MAX_AGENTS,
  PLUGIN_MAX_PANELS,
  PLUGIN_MAX_SKILLS,
  PLUGIN_MCP_JSON_MAX_BYTES,
  PLUGIN_PANEL_HTML_MAX_CHARS,
  PLUGIN_SKILL_MAX_BYTES,
  PLUGIN_WORKER_CODE_MAX_CHARS,
  PLUGIN_WORKER_MAX_FOLDERS,
  type PluginContribution,
  type PluginExternalStatus,
  type PluginHookMatcherGroup,
  PluginId,
  PluginManifest,
  type PluginManifestWorkerFolder,
  type PluginMcpServerConfig,
  type PluginMcpServerStatus,
  PluginOperationError,
  type PluginSettingEntry,
  type PluginWorkerEveryMinutes,
  type PluginWorkerFolderAccess,
  type PluginWorkerStatus,
  type ProjectId,
  REPO_PLUGIN_MAX_FOLDERS,
  type RepoPluginStatus,
  type ServerApprovePluginWorkerResult,
  type ServerListPluginsResult,
  type ServerRestorePluginRevisionResult,
  type ServerSetPluginEnabledResult,
  type ServerSetPluginWorkerFolderResult,
  type ServerUninstallPluginResult,
  THEME_CSS_MAX_LENGTH,
} from "@t3tools/contracts";
import type { ProviderAdapterV2PluginAgent } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProjectContextPlugin } from "@t3tools/provider-core/server/projectInstructions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { readThemeFileGuarded } from "../environmentTheme.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { watchDirectoryPath } from "../watchDirectoryReplacements.ts";
import { writeFileAtomic } from "./atomicFile.ts";
import {
  computePluginMcpServerConfigKey,
  expandPluginHooksEventMap,
  formatPluginAgentMarkdown,
  PLUGIN_AGENTS_DIR,
  PLUGIN_HOOKS_FILE,
  PLUGIN_MCP_FILE,
  type PluginAgentWriteContent,
  pluginDataDirFor,
  resolveManifestExternalJsonPath,
  type ScannedPluginAgent,
  type ScannedPluginMcpServer,
  scanPluginExternalParts,
  validateAndSerializePluginHooksWrite,
  validateAndSerializePluginMcpWrite,
} from "./pluginExternalConfig.ts";
import {
  formatPluginSkillMarkdown,
  parsePluginSkillMarkdown,
  type PluginSlashCommandEntry,
} from "./pluginSlashCommand.ts";
import {
  computePluginWorkerPowersHash,
  detectPluginWorkerRuntimeCapabilities,
  validateAndCanonicalizeWorkerFolderPath,
} from "./pluginWorkerUtils.ts";

const PLUGINS_ARCHIVE_DIR_NAME = "plugins-archive";
const PLUGINS_HISTORY_DIR_NAME = "plugins-history";
const PLUGIN_CSS_FILE = "plugin.css";
const PLUGIN_WORKER_FILE = "worker.mjs";
const PLUGIN_INSTRUCTIONS_FILE = "AGENTS.md";
const PLUGIN_SKILLS_DIR = "skills";
const PLUGIN_SKILL_FILE = "SKILL.md";
const PLUGIN_COMMANDS_DIR = "commands";
const MAX_PLUGIN_FOLDERS = 64;
const MAX_PLUGIN_HISTORY_REVISIONS = 20;
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
const MAX_PLUGIN_CSS_BYTES = 4 * THEME_CSS_MAX_LENGTH;
const MAX_PLUGIN_WORKER_BYTES = 4 * PLUGIN_WORKER_CODE_MAX_CHARS;
const RACY_MTIME_WINDOW_MS = 2_000;
const PLUGIN_REVISION_PATTERN = /^[a-f0-9]{12}$/;
const PANEL_ROOT_ENTRY_PATTERN = /^\.\/(?!\.)[^/\\\0]+\.html$/;
const WORKER_ROOT_ENTRY_PATTERN = /^\.\/(?!\.)[^/\\\0]+\.mjs$/;
const UNSUPPORTED_PART_ORDER = ["hooks", "mcp", "agents", "css", "panels", "worker"] as const;

const isPluginId = Schema.is(PluginId);
const isPluginRevision = (value: string): boolean => PLUGIN_REVISION_PATTERN.test(value);
const decodePluginManifestExit = Schema.decodeUnknownExit(PluginManifest);
const decodePluginManifestJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(PluginManifest),
);
const encodePluginManifestJson = Schema.encodeEffect(fromJsonStringPretty(PluginManifest));

interface RawPluginTextFile {
  readonly relativePath: string;
  readonly content: string;
}

const sortRawTextFiles = (
  files: ReadonlyArray<RawPluginTextFile>,
): ReadonlyArray<RawPluginTextFile> =>
  [...files].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );

const computePluginRevision = (
  manifestText: string,
  cssText: string,
  panelHtmls: ReadonlyArray<string> = [],
  workerCode?: string,
  textFiles: ReadonlyArray<RawPluginTextFile> = [],
): string => {
  const hash = NodeCrypto.createHash("sha256").update(manifestText).update("\0").update(cssText);
  for (const html of panelHtmls) {
    hash.update("\0").update(html);
  }
  if (workerCode !== undefined) {
    hash.update("\0").update(workerCode);
  }
  if (textFiles.length > 0) {
    for (const file of sortRawTextFiles(textFiles)) {
      hash.update("\0").update(file.relativePath).update("\0").update(file.content);
    }
  }
  return hash.digest("hex").slice(0, 12);
};

export interface PluginWorkerContent {
  readonly code: string;
  readonly everyMinutes?: PluginWorkerEveryMinutes;
  readonly folders?: ReadonlyArray<PluginManifestWorkerFolder>;
  readonly network?: boolean;
}

export interface PluginWorkerDesiredSpec {
  readonly pluginId: PluginId;
  readonly enabled: boolean;
  readonly runnable: boolean;
  readonly pluginRootReal: string;
  readonly entryCanonicalPath: string;
  readonly workerCodeHash: string;
  readonly powersHash: string;
  readonly everyMinutes?: PluginWorkerEveryMinutes;
  readonly folders: ReadonlyArray<{
    readonly id: PluginId;
    readonly label: string;
    readonly access: PluginWorkerFolderAccess;
    readonly realPath: string | null;
  }>;
  readonly network: boolean;
}

export interface PluginWorkerRuntimeState {
  readonly status?: "running" | "stopped" | "crashed";
  readonly lastRunAt?: IsoDateTime;
  readonly lastError?: string;
  readonly runtimeProblem?: string;
  readonly networkRestricted?: boolean;
}

export interface PluginMcpServerDesiredSpec {
  readonly pluginId: PluginId;
  readonly pluginDisplayName?: string;
  readonly pluginRootReal: string;
  readonly pluginDataDir: string;
  readonly serverName: string;
  readonly configKey: string;
  readonly transport:
    | {
        readonly kind: "stdio";
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly env: Readonly<Record<string, string>>;
      }
    | {
        readonly kind: "http";
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
      };
  readonly timeoutMs?: number;
}

export interface PluginMcpServerRuntimeState {
  readonly status: "starting" | "running" | "failed" | "stopped";
  readonly toolCount?: number;
  readonly truncatedTools?: boolean;
  readonly error?: string;
}

interface PluginSnapshot {
  readonly seq: number;
  readonly workerSeq: number;
  readonly mcpSeq: number;
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  readonly active: ReadonlyArray<EnvironmentPlugin>;
  readonly panelEntries: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly workerSpecs: ReadonlyArray<PluginWorkerDesiredSpec>;
  readonly mcpSpecs: ReadonlyArray<PluginMcpServerDesiredSpec>;
  readonly externalPowersHashes: ReadonlyMap<string, string>;
  readonly activeUserScanned: ReadonlyArray<ScannedPlugin>;
}

interface ScannedSkill {
  readonly name: PluginId;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
  readonly body: string;
  readonly filePath: string;
  readonly skillDir: string;
  readonly source: "skill" | "command";
  readonly relativePath: string;
}

interface ScannedPanel {
  readonly id: PluginId;
  readonly title: string;
  readonly fileName: string;
  readonly canonicalPath: string;
  readonly html: string;
}

interface ScannedWorker {
  readonly fileName: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly code: string;
  readonly codeHash: string;
  readonly powersHash: string;
  readonly everyMinutes?: PluginWorkerEveryMinutes;
  readonly folders: ReadonlyArray<PluginManifestWorkerFolder>;
  readonly network: boolean;
  readonly desired: PluginWorkerDesiredSpec;
}

interface ScannedPlugin {
  readonly plugin: InstalledPlugin;
  readonly pluginRootReal?: string;
  readonly pluginDataDir?: string;
  readonly css?: string;
  readonly cssPath?: string;
  readonly panels?: ReadonlyArray<ScannedPanel>;
  readonly worker?: ScannedWorker;
  readonly skills?: ReadonlyArray<ScannedSkill>;
  readonly instructions?: string;
  readonly mcpServers?: ReadonlyArray<ScannedPluginMcpServer>;
  readonly mcpDesiredSpecs?: ReadonlyArray<PluginMcpServerDesiredSpec>;
  readonly hooks?: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>;
  readonly agents?: ReadonlyArray<ScannedPluginAgent>;
  readonly externalPowersHash?: string;
  readonly externalApproved?: boolean;
  readonly manifestMcpServers?: unknown;
  readonly manifestHooks?: unknown;
  readonly rawManifest?: string;
  readonly rawCss?: string;
  readonly rawPanels?: ReadonlyArray<{ readonly fileName: string; readonly html: string }>;
  readonly rawWorker?: { readonly fileName: string; readonly code: string };
  readonly rawTextFiles?: ReadonlyArray<RawPluginTextFile>;
}

export interface PluginPanelContent {
  readonly id: PluginId;
  readonly title: string;
  readonly html: string;
}

export interface PluginSkillContent {
  readonly name: PluginId;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly userInvocable?: boolean;
  readonly modelInvocable?: boolean;
  readonly body: string;
}

export interface PluginReadResult {
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly css?: string;
  readonly panels?: ReadonlyArray<PluginPanelContent>;
  readonly worker?: PluginWorkerContent;
  readonly skills?: ReadonlyArray<PluginSkillContent>;
  readonly instructions?: string;
  readonly mcpServers?: Readonly<Record<string, PluginMcpServerConfig>>;
  readonly hooks?: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>;
  readonly agents?: ReadonlyArray<PluginAgentWriteContent>;
}

export interface PluginWriteInput {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly css?: string;
  readonly panels?: ReadonlyArray<PluginPanelContent>;
  readonly worker?: PluginWorkerContent;
  readonly skills?: ReadonlyArray<PluginSkillContent>;
  readonly instructions?: string;
  readonly mcpServers?: Readonly<Record<string, PluginMcpServerConfig>>;
  readonly hooks?: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>;
  readonly agents?: ReadonlyArray<PluginAgentWriteContent>;
}

export interface PluginWriteResult {
  readonly plugin: InstalledPlugin;
  readonly created: boolean;
  readonly before?: string;
  readonly after: string;
}

export interface PluginTurnContext {
  readonly contextPlugins: ReadonlyArray<ProjectContextPlugin>;
  readonly commands: ReadonlyArray<PluginSlashCommandEntry>;
  readonly hooks?: Readonly<Record<string, ReadonlyArray<PluginHookMatcherGroup>>>;
  readonly agents?: ReadonlyArray<ProviderAdapterV2PluginAgent>;
}

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ServerListPluginsResult, PluginOperationError>;
    readonly read: (id: string) => Effect.Effect<PluginReadResult, PluginOperationError>;
    readonly write: (
      input: PluginWriteInput,
    ) => Effect.Effect<PluginWriteResult, PluginOperationError>;
    readonly restore: (
      id: string,
      revision: string,
      enable?: boolean,
      options?: {
        readonly approveWorker?: boolean;
        readonly approveExternal?: boolean;
        readonly projectId?: ProjectId;
      },
    ) => Effect.Effect<ServerRestorePluginRevisionResult, PluginOperationError>;
    readonly setEnabled: (
      id: string,
      enabled: boolean,
      options?: {
        readonly approveWorker?: boolean;
        readonly approveExternal?: boolean;
        readonly revision?: string;
        readonly projectId?: ProjectId;
      },
    ) => Effect.Effect<ServerSetPluginEnabledResult, PluginOperationError>;
    readonly approveWorker: (
      id: string,
      revision?: string,
    ) => Effect.Effect<ServerApprovePluginWorkerResult, PluginOperationError>;
    readonly setWorkerFolder: (
      id: string,
      folderId: PluginId,
      path: string | null,
    ) => Effect.Effect<ServerSetPluginWorkerFolderResult, PluginOperationError>;
    readonly uninstall: (
      id: string,
      projectId?: ProjectId,
    ) => Effect.Effect<ServerUninstallPluginResult, PluginOperationError>;
    readonly resolvePanelEntry: (
      pluginId: string,
      panelId: string,
    ) => Effect.Effect<string, PluginOperationError>;
    readonly reportWorkerRuntime: (
      pluginId: string,
      state: PluginWorkerRuntimeState | null,
    ) => Effect.Effect<void>;
    readonly reportMcpRuntime: (
      pluginId: string,
      serverName: string,
      state: PluginMcpServerRuntimeState | null,
    ) => Effect.Effect<void>;
    readonly getTurnContext: (projectId: ProjectId) => Effect.Effect<PluginTurnContext>;
    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentPlugin>>;
    readonly streamWorkerDesiredState: Stream.Stream<ReadonlyArray<PluginWorkerDesiredSpec>>;
    readonly streamMcpDesiredState: Stream.Stream<ReadonlyArray<PluginMcpServerDesiredSpec>>;
  }
>()("t3/plugins/PluginRegistry") {}

const isSafeFolderName = (id: string): boolean =>
  id.length > 0 &&
  !id.startsWith(".") &&
  !id.includes("/") &&
  !id.includes("\\") &&
  !id.includes("\0");

const isInsideDirectory = (
  rootPath: string,
  candidatePath: string,
  allowEqual: boolean,
): boolean => {
  const relative = NodePath.relative(rootPath, candidatePath);
  if (relative === "") return allowEqual;
  return !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const lstatOrNull = (targetPath: string): NodeFS.Stats | null => {
  try {
    return NodeFS.lstatSync(targetPath);
  } catch {
    return null;
  }
};

const pathExists = (targetPath: string): boolean => lstatOrNull(targetPath) !== null;

const isErrnoCode = (error: unknown, code: string): boolean =>
  Predicate.hasProperty(error, "code") && error.code === code;

const isMissingPath = (error: unknown): boolean =>
  isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR");

type PluginMetadata = Pick<InstalledPlugin, "displayName" | "description" | "version">;

const withProblem = (
  id: string,
  problem: string,
  metadata: PluginMetadata = {},
  extra: {
    readonly revision?: string;
    readonly unsupported?: ReadonlyArray<string>;
    readonly rawManifest?: string;
    readonly rawCss?: string;
    readonly cssPath?: string;
    readonly rawPanels?: ReadonlyArray<{ readonly fileName: string; readonly html: string }>;
    readonly rawWorker?: { readonly fileName: string; readonly code: string };
    readonly rawTextFiles?: ReadonlyArray<RawPluginTextFile>;
    readonly workerPath?: string;
  } = {},
): ScannedPlugin => ({
  plugin: {
    id,
    ...metadata,
    enabled: false,
    contributes: [],
    ...(extra.unsupported !== undefined && extra.unsupported.length > 0
      ? { unsupported: extra.unsupported }
      : {}),
    ...(extra.revision !== undefined ? { revision: extra.revision } : {}),
    problem,
  },
  ...(extra.rawManifest !== undefined ? { rawManifest: extra.rawManifest } : {}),
  ...(extra.rawCss !== undefined ? { rawCss: extra.rawCss } : {}),
  ...(extra.cssPath !== undefined ? { cssPath: extra.cssPath } : {}),
  ...(extra.rawPanels !== undefined ? { rawPanels: extra.rawPanels } : {}),
  ...(extra.rawWorker !== undefined ? { rawWorker: extra.rawWorker } : {}),
  ...(extra.rawTextFiles !== undefined && extra.rawTextFiles.length > 0
    ? { rawTextFiles: extra.rawTextFiles }
    : {}),
});

const resolveSafePluginFilePath = (
  folderPath: string,
  relativePath: string,
  allowSubfolders: boolean,
  rootPattern: RegExp = PANEL_ROOT_ENTRY_PATTERN,
): string | null => {
  if (
    !relativePath.startsWith("./") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    return null;
  }
  const resolvedFolder = NodePath.resolve(folderPath);
  const resolvedPath = NodePath.resolve(folderPath, relativePath);
  if (!isInsideDirectory(resolvedFolder, resolvedPath, false)) {
    return null;
  }
  if (
    !allowSubfolders &&
    (NodePath.dirname(resolvedPath) !== resolvedFolder || !rootPattern.test(relativePath))
  ) {
    return null;
  }
  return resolvedPath;
};

const readPluginFileGuarded = (
  folderPath: string,
  pluginRootReal: string,
  relativePath: string,
  options: {
    readonly kind: "CSS" | "Panel" | "Worker";
    readonly maxBytes: number;
    readonly allowSubfolders: boolean;
    readonly rootPattern?: RegExp;
    readonly oversizeProblem?: string;
  },
):
  | {
      readonly ok: true;
      readonly path: string;
      readonly canonicalPath: string;
      readonly content: string;
    }
  | { readonly ok: false; readonly problem: string } => {
  const resolvedPath = resolveSafePluginFilePath(
    folderPath,
    relativePath,
    options.allowSubfolders,
    options.rootPattern,
  );
  if (resolvedPath === null) {
    return {
      ok: false,
      problem: options.allowSubfolders
        ? `${options.kind} path must start with "./" and stay inside the plugin folder.`
        : options.kind === "Worker"
          ? `${options.kind} path must be "./<name>.mjs" at the plugin folder root.`
          : `${options.kind} path must be "./<name>.html" at the plugin folder root.`,
    };
  }
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(resolvedPath);
  } catch (error) {
    return {
      ok: false,
      problem: isMissingPath(error)
        ? `${options.kind} file "${relativePath}" was not found.`
        : `${options.kind} file "${relativePath}" could not be accessed.`,
    };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, problem: `${options.kind} file "${relativePath}" cannot be a symlink.` };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      problem: `${options.kind} file "${relativePath}" is not a regular file.`,
    };
  }
  if (stat.size > options.maxBytes) {
    return {
      ok: false,
      problem:
        options.oversizeProblem ??
        `${options.kind} file "${relativePath}" exceeds the ${options.maxBytes} byte limit.`,
    };
  }
  const dirReal = realpathOrNull(NodePath.dirname(resolvedPath));
  if (dirReal === null || !isInsideDirectory(pluginRootReal, dirReal, true)) {
    return { ok: false, problem: `${options.kind} path must stay inside the plugin folder.` };
  }
  const content = readThemeFileGuarded(resolvedPath, options.maxBytes);
  if (content === null) {
    return { ok: false, problem: `${options.kind} file "${relativePath}" could not be read.` };
  }
  return {
    ok: true,
    path: resolvedPath,
    canonicalPath: NodePath.join(dirReal, NodePath.basename(resolvedPath)),
    content,
  };
};

const relativePosixToFsPath = (baseDir: string, relativePath: string): string =>
  NodePath.join(baseDir, ...relativePath.split("/"));

const hasNonEmptyManifestField = (raw: unknown, key: string): boolean => {
  if (!Predicate.hasProperty(raw, key)) return false;
  const value = raw[key];
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (Predicate.isObject(value)) return Object.keys(value).length > 0;
  return false;
};

const detectUnsupportedParts = (
  folderPath: string,
  parsedJson: unknown,
  manifest: PluginManifest,
  isRepo: boolean,
): ReadonlyArray<string> => {
  if (!isRepo) {
    return [];
  }
  const found = new Set<string>();
  if (
    hasNonEmptyManifestField(parsedJson, "hooks") ||
    lstatOrNull(NodePath.join(folderPath, "hooks", "hooks.json")) !== null
  ) {
    found.add("hooks");
  }
  if (
    hasNonEmptyManifestField(parsedJson, "mcpServers") ||
    lstatOrNull(NodePath.join(folderPath, ".mcp.json")) !== null
  ) {
    found.add("mcp");
  }
  if (manifest.css !== undefined) found.add("css");
  if (manifest.panels !== undefined && manifest.panels.length > 0) found.add("panels");
  if (manifest.worker !== undefined) found.add("worker");
  return UNSUPPORTED_PART_ORDER.filter((part) => found.has(part));
};

const readDirEntriesSorted = (dirPath: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(dirPath).toSorted();
  } catch {
    return [];
  }
};

const readGuardedTextPart = (
  filePath: string,
  pluginRootReal: string,
  relativeLabel: string,
  kindLabel: string,
  maxBytes: number,
  maxKbLabel: string,
):
  | { readonly ok: true; readonly canonicalPath: string; readonly content: string }
  | { readonly ok: false; readonly problem: string } => {
  const stat = lstatOrNull(filePath);
  if (stat === null) {
    return { ok: false, problem: `${kindLabel} "${relativeLabel}" could not be accessed.` };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, problem: `${kindLabel} "${relativeLabel}" cannot be a symlink.` };
  }
  if (!stat.isFile()) {
    return { ok: false, problem: `${kindLabel} "${relativeLabel}" is not a regular file.` };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      problem: `${kindLabel} "${relativeLabel}" exceeds the ${maxKbLabel} limit.`,
    };
  }
  const dirReal = realpathOrNull(NodePath.dirname(filePath));
  if (dirReal === null || !isInsideDirectory(pluginRootReal, dirReal, true)) {
    return {
      ok: false,
      problem: `${kindLabel} "${relativeLabel}" must stay inside the plugin folder.`,
    };
  }
  const content = readThemeFileGuarded(filePath, maxBytes);
  if (content === null) {
    return { ok: false, problem: `${kindLabel} "${relativeLabel}" could not be read.` };
  }
  return {
    ok: true,
    canonicalPath: NodePath.join(dirReal, NodePath.basename(filePath)),
    content,
  };
};

interface ScannedTextParts {
  readonly ok: true;
  readonly instructions?: string;
  readonly skills: ReadonlyArray<ScannedSkill>;
  readonly rawTextFiles: ReadonlyArray<RawPluginTextFile>;
}

const scanPluginTextParts = (
  folderPath: string,
  pluginRootReal: string,
):
  | ScannedTextParts
  | {
      readonly ok: false;
      readonly problem: string;
      readonly rawTextFiles: ReadonlyArray<RawPluginTextFile>;
    } => {
  const rawTextFiles: Array<RawPluginTextFile> = [];
  const skills: Array<ScannedSkill> = [];
  const skillDirNames = new Set<string>();
  const seenSkillNames = new Set<string>();
  let instructions: string | undefined;
  let totalEntries = 0;

  const instructionsPath = NodePath.join(folderPath, PLUGIN_INSTRUCTIONS_FILE);
  if (lstatOrNull(instructionsPath) !== null) {
    const read = readGuardedTextPart(
      instructionsPath,
      pluginRootReal,
      PLUGIN_INSTRUCTIONS_FILE,
      "Instructions file",
      PLUGIN_INSTRUCTIONS_MAX_BYTES,
      "8 KB",
    );
    if (!read.ok) return { ok: false, problem: read.problem, rawTextFiles };
    rawTextFiles.push({ relativePath: PLUGIN_INSTRUCTIONS_FILE, content: read.content });
    if (read.content.trim().length > 0) {
      instructions = read.content;
    }
  }

  const skillsDir = NodePath.join(folderPath, PLUGIN_SKILLS_DIR);
  const skillsDirStat = lstatOrNull(skillsDir);
  if (skillsDirStat !== null) {
    if (skillsDirStat.isSymbolicLink()) {
      return {
        ok: false,
        problem: `Directory "${PLUGIN_SKILLS_DIR}" cannot be a symlink.`,
        rawTextFiles,
      };
    }
    if (skillsDirStat.isDirectory()) {
      for (const entry of readDirEntriesSorted(skillsDir)) {
        if (entry.startsWith(".")) continue;
        const entryDir = NodePath.join(skillsDir, entry);
        const entryStat = lstatOrNull(entryDir);
        if (entryStat === null) continue;
        if (entryStat.isSymbolicLink()) {
          return {
            ok: false,
            problem: `Skill folder "${PLUGIN_SKILLS_DIR}/${entry}" cannot be a symlink.`,
            rawTextFiles,
          };
        }
        if (!entryStat.isDirectory()) continue;
        const skillFilePath = NodePath.join(entryDir, PLUGIN_SKILL_FILE);
        if (lstatOrNull(skillFilePath) === null) continue;

        totalEntries += 1;
        if (totalEntries > PLUGIN_MAX_SKILLS) {
          return {
            ok: false,
            problem: `Plugin exceeds the ${PLUGIN_MAX_SKILLS} skills and commands limit.`,
            rawTextFiles,
          };
        }
        const relativePath = `${PLUGIN_SKILLS_DIR}/${entry}/${PLUGIN_SKILL_FILE}`;
        const read = readGuardedTextPart(
          skillFilePath,
          pluginRootReal,
          relativePath,
          "Skill file",
          PLUGIN_SKILL_MAX_BYTES,
          "32 KB",
        );
        if (!read.ok) return { ok: false, problem: read.problem, rawTextFiles };
        rawTextFiles.push({ relativePath, content: read.content });

        const parsed = parsePluginSkillMarkdown(read.content);
        if (!parsed.ok) {
          return {
            ok: false,
            problem: `Invalid frontmatter in "${relativePath}": ${parsed.problem}`,
            rawTextFiles,
          };
        }
        const effectiveName = parsed.name ?? entry;
        if (!isPluginId(effectiveName)) {
          return {
            ok: false,
            problem: `Skill name "${effectiveName}" in "${relativePath}" is not a valid plugin id.`,
            rawTextFiles,
          };
        }
        if (seenSkillNames.has(effectiveName)) {
          return {
            ok: false,
            problem: `Duplicate skill name "${effectiveName}" in "${relativePath}".`,
            rawTextFiles,
          };
        }
        skillDirNames.add(entry);
        seenSkillNames.add(effectiveName);
        skills.push({
          name: effectiveName,
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
          userInvocable: parsed.userInvocable,
          modelInvocable: parsed.modelInvocable,
          body: parsed.body,
          filePath: read.canonicalPath,
          skillDir: NodePath.dirname(read.canonicalPath),
          source: "skill",
          relativePath,
        });
      }
    }
  }

  const commandsDir = NodePath.join(folderPath, PLUGIN_COMMANDS_DIR);
  const commandsDirStat = lstatOrNull(commandsDir);
  if (commandsDirStat !== null) {
    if (commandsDirStat.isSymbolicLink()) {
      return {
        ok: false,
        problem: `Directory "${PLUGIN_COMMANDS_DIR}" cannot be a symlink.`,
        rawTextFiles,
      };
    }
    if (commandsDirStat.isDirectory()) {
      for (const entry of readDirEntriesSorted(commandsDir)) {
        if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
        const commandFilePath = NodePath.join(commandsDir, entry);
        const entryStat = lstatOrNull(commandFilePath);
        if (entryStat === null || entryStat.isDirectory()) continue;
        const relativePath = `${PLUGIN_COMMANDS_DIR}/${entry}`;
        if (entryStat.isSymbolicLink()) {
          return {
            ok: false,
            problem: `Command file "${relativePath}" cannot be a symlink.`,
            rawTextFiles,
          };
        }
        if (!entryStat.isFile()) continue;

        totalEntries += 1;
        if (totalEntries > PLUGIN_MAX_SKILLS) {
          return {
            ok: false,
            problem: `Plugin exceeds the ${PLUGIN_MAX_SKILLS} skills and commands limit.`,
            rawTextFiles,
          };
        }
        const read = readGuardedTextPart(
          commandFilePath,
          pluginRootReal,
          relativePath,
          "Command file",
          PLUGIN_SKILL_MAX_BYTES,
          "32 KB",
        );
        if (!read.ok) return { ok: false, problem: read.problem, rawTextFiles };
        rawTextFiles.push({ relativePath, content: read.content });

        const parsed = parsePluginSkillMarkdown(read.content);
        if (!parsed.ok) {
          return {
            ok: false,
            problem: `Invalid frontmatter in "${relativePath}": ${parsed.problem}`,
            rawTextFiles,
          };
        }
        const stem = entry.slice(0, -3);
        const effectiveName = parsed.name ?? stem;
        if (!isPluginId(effectiveName)) {
          return {
            ok: false,
            problem: `Command name "${effectiveName}" in "${relativePath}" is not a valid plugin id.`,
            rawTextFiles,
          };
        }
        // When a skill and a legacy command collide by folder/file name or resolved name, skill wins.
        if (skillDirNames.has(stem) || seenSkillNames.has(effectiveName)) {
          continue;
        }
        seenSkillNames.add(effectiveName);
        skills.push({
          name: effectiveName,
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
          userInvocable: parsed.userInvocable,
          modelInvocable: parsed.modelInvocable,
          body: parsed.body,
          filePath: read.canonicalPath,
          skillDir: NodePath.dirname(read.canonicalPath),
          source: "command",
          relativePath,
        });
      }
    }
  }

  return {
    ok: true,
    ...(instructions !== undefined ? { instructions } : {}),
    skills,
    rawTextFiles: sortRawTextFiles(rawTextFiles),
  };
};

const readHistoryTextFiles = (
  revisionDir: string,
  extraJsonRelativePaths: ReadonlyArray<string> = [],
):
  | { readonly ok: true; readonly files: ReadonlyArray<RawPluginTextFile> }
  | { readonly ok: false } => {
  const filesByPath = new Map<string, string>();
  const checkNoSymlink = (targetPath: string): boolean =>
    lstatOrNull(targetPath)?.isSymbolicLink() !== true;

  const readJsonRelative = (relativePath: string, maxBytes: number): boolean => {
    if (filesByPath.has(relativePath)) return true;
    const parts = relativePath.split("/");
    let current = revisionDir;
    for (const part of parts) {
      current = NodePath.join(current, part);
      const stat = lstatOrNull(current);
      if (stat === null) return true;
      if (stat.isSymbolicLink()) return false;
    }
    const stat = lstatOrNull(current);
    if (stat === null) return true;
    if (!stat.isFile()) return false;
    const content = readThemeFileGuarded(current, maxBytes);
    if (content === null) return false;
    filesByPath.set(relativePath, content);
    return true;
  };

  const instructionsPath = NodePath.join(revisionDir, PLUGIN_INSTRUCTIONS_FILE);
  const instructionsStat = lstatOrNull(instructionsPath);
  if (instructionsStat !== null) {
    if (instructionsStat.isSymbolicLink() || !instructionsStat.isFile()) return { ok: false };
    const content = readThemeFileGuarded(instructionsPath, PLUGIN_INSTRUCTIONS_MAX_BYTES);
    if (content === null) return { ok: false };
    filesByPath.set(PLUGIN_INSTRUCTIONS_FILE, content);
  }

  const skillsDir = NodePath.join(revisionDir, PLUGIN_SKILLS_DIR);
  const skillsDirStat = lstatOrNull(skillsDir);
  if (skillsDirStat !== null) {
    if (skillsDirStat.isSymbolicLink() || !skillsDirStat.isDirectory()) return { ok: false };
    for (const entry of readDirEntriesSorted(skillsDir)) {
      if (!isSafeFolderName(entry)) return { ok: false };
      const entryDir = NodePath.join(skillsDir, entry);
      const entryStat = lstatOrNull(entryDir);
      if (entryStat === null || entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        return { ok: false };
      }
      const skillFile = NodePath.join(entryDir, PLUGIN_SKILL_FILE);
      if (!checkNoSymlink(skillFile)) return { ok: false };
      const content = readThemeFileGuarded(skillFile, PLUGIN_SKILL_MAX_BYTES);
      if (content === null) return { ok: false };
      filesByPath.set(`${PLUGIN_SKILLS_DIR}/${entry}/${PLUGIN_SKILL_FILE}`, content);
    }
  }

  const commandsDir = NodePath.join(revisionDir, PLUGIN_COMMANDS_DIR);
  const commandsDirStat = lstatOrNull(commandsDir);
  if (commandsDirStat !== null) {
    if (commandsDirStat.isSymbolicLink() || !commandsDirStat.isDirectory()) return { ok: false };
    for (const entry of readDirEntriesSorted(commandsDir)) {
      if (!isSafeFolderName(entry) || !entry.endsWith(".md")) return { ok: false };
      const commandFile = NodePath.join(commandsDir, entry);
      if (!checkNoSymlink(commandFile)) return { ok: false };
      const content = readThemeFileGuarded(commandFile, PLUGIN_SKILL_MAX_BYTES);
      if (content === null) return { ok: false };
      filesByPath.set(`${PLUGIN_COMMANDS_DIR}/${entry}`, content);
    }
  }

  const agentsDir = NodePath.join(revisionDir, PLUGIN_AGENTS_DIR);
  const agentsDirStat = lstatOrNull(agentsDir);
  if (agentsDirStat !== null) {
    if (agentsDirStat.isSymbolicLink() || !agentsDirStat.isDirectory()) return { ok: false };
    for (const entry of readDirEntriesSorted(agentsDir)) {
      if (!isSafeFolderName(entry) || !entry.endsWith(".md")) return { ok: false };
      const agentFile = NodePath.join(agentsDir, entry);
      if (!checkNoSymlink(agentFile)) return { ok: false };
      const content = readThemeFileGuarded(agentFile, PLUGIN_AGENT_MAX_BYTES);
      if (content === null) return { ok: false };
      filesByPath.set(`${PLUGIN_AGENTS_DIR}/${entry}`, content);
    }
  }

  if (!readJsonRelative(PLUGIN_MCP_FILE, PLUGIN_MCP_JSON_MAX_BYTES)) return { ok: false };
  if (!readJsonRelative(PLUGIN_HOOKS_FILE, PLUGIN_HOOKS_JSON_MAX_BYTES)) return { ok: false };
  for (const extraRel of extraJsonRelativePaths) {
    if (
      !readJsonRelative(extraRel, Math.max(PLUGIN_MCP_JSON_MAX_BYTES, PLUGIN_HOOKS_JSON_MAX_BYTES))
    ) {
      return { ok: false };
    }
  }

  const files = [...filesByPath.entries()].map(([relativePath, content]) => ({
    relativePath,
    content,
  }));
  return { ok: true, files: sortRawTextFiles(files) };
};

const isExistingTargetSafe = (
  folderPath: string,
  targetCssPath: string | null,
  targetPanelPaths: ReadonlyArray<string>,
  targetWorkerPath: string | null = null,
  targetTextRelativePaths: ReadonlyArray<string> = [],
): boolean => {
  const folderStat = lstatOrNull(folderPath);
  if (folderStat === null) return true;
  if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) return false;
  const manifestDir = NodePath.join(folderPath, PLUGIN_MANIFEST_DIR);
  const manifestDirStat = lstatOrNull(manifestDir);
  if (
    manifestDirStat !== null &&
    (manifestDirStat.isSymbolicLink() || !manifestDirStat.isDirectory())
  ) {
    return false;
  }
  const manifestPath = NodePath.join(manifestDir, PLUGIN_MANIFEST_FILE);
  if (lstatOrNull(manifestPath)?.isSymbolicLink() === true) return false;
  if (targetCssPath !== null) {
    if (lstatOrNull(targetCssPath)?.isSymbolicLink() === true) return false;
    const cssDir = NodePath.dirname(targetCssPath);
    if (cssDir !== folderPath && lstatOrNull(cssDir)?.isSymbolicLink() === true) return false;
  }
  for (const panelPath of targetPanelPaths) {
    if (lstatOrNull(panelPath)?.isSymbolicLink() === true) return false;
  }
  if (targetWorkerPath !== null && lstatOrNull(targetWorkerPath)?.isSymbolicLink() === true) {
    return false;
  }
  for (const rel of targetTextRelativePaths) {
    const parts = rel.split("/");
    let current = folderPath;
    for (let index = 0; index < parts.length; index += 1) {
      current = NodePath.join(current, parts[index]!);
      const stat = lstatOrNull(current);
      if (stat === null) break;
      if (stat.isSymbolicLink()) return false;
      if (index < parts.length - 1 && !stat.isDirectory()) return false;
    }
  }
  return true;
};

// Untraced: called inside traced PluginRegistry write/restore spans.
// Removes only files the previous scan owned; their copies are in the `before` revision.
const cleanupStalePluginFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  folderPath: string,
  previousPanelFileNames: ReadonlyArray<string>,
  keepPanelFileNames: ReadonlySet<string>,
  previousCssPath: string | null,
  nextCssPath: string | null,
  previousWorkerPath: string | null = null,
  nextWorkerPath: string | null = null,
  previousTextRelativePaths: ReadonlyArray<string> = [],
  keepTextRelativePaths: ReadonlySet<string> = new Set(),
) {
  const stale = previousPanelFileNames
    .filter((fileName) => !keepPanelFileNames.has(fileName))
    .map((fileName) => NodePath.join(folderPath, fileName));
  if (previousCssPath !== null && previousCssPath !== nextCssPath) stale.push(previousCssPath);
  if (previousWorkerPath !== null && previousWorkerPath !== nextWorkerPath) {
    stale.push(previousWorkerPath);
  }
  const staleTextDirs = new Set<string>();
  for (const rel of previousTextRelativePaths) {
    if (keepTextRelativePaths.has(rel)) continue;
    const full = relativePosixToFsPath(folderPath, rel);
    stale.push(full);
    let parent = NodePath.dirname(full);
    while (parent !== folderPath && isInsideDirectory(folderPath, parent, false)) {
      staleTextDirs.add(parent);
      parent = NodePath.dirname(parent);
    }
  }
  for (const candidate of stale) {
    const stat = lstatOrNull(candidate);
    if (stat !== null && !stat.isSymbolicLink() && stat.isFile()) {
      yield* fs.remove(candidate, { force: true }).pipe(Effect.ignoreCause({ log: true }));
    }
  }
  // Remove emptied skill/command subdirectories deepest-first without touching unrelated user files.
  const dirsDeepestFirst = [...staleTextDirs].sort((left, right) => right.length - left.length);
  for (const dir of dirsDeepestFirst) {
    const stat = lstatOrNull(dir);
    if (stat !== null && !stat.isSymbolicLink() && stat.isDirectory()) {
      if (readDirEntriesSorted(dir).length === 0) {
        yield* fs.remove(dir).pipe(Effect.ignoreCause({ log: true }));
      }
    }
  }
});

// Untraced: called inside traced PluginRegistry write/restore spans.
const saveHistoryRevision = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  stateDir: string,
  pluginId: string,
  manifestText: string,
  cssText: string,
  panels: ReadonlyArray<{ readonly fileName: string; readonly html: string }>,
  operation: "write" | "restore",
  worker?: { readonly fileName: string; readonly code: string },
  textFiles: ReadonlyArray<RawPluginTextFile> = [],
) {
  const sortedTextFiles = sortRawTextFiles(textFiles);
  const revision = computePluginRevision(
    manifestText,
    cssText,
    panels.map((panel) => panel.html),
    worker?.code,
    sortedTextFiles,
  );
  const historyRoot = NodePath.join(stateDir, PLUGINS_HISTORY_DIR_NAME);
  const pluginHistoryDir = NodePath.join(historyRoot, pluginId);
  const revisionDir = NodePath.join(pluginHistoryDir, revision);
  const manifestPath = NodePath.join(revisionDir, PLUGIN_MANIFEST_FILE);
  const cssPath = NodePath.join(revisionDir, PLUGIN_CSS_FILE);
  const panelTargets = panels.map((panel) => ({
    path: NodePath.join(revisionDir, panel.fileName),
    html: panel.html,
  }));
  const workerTarget =
    worker === undefined
      ? null
      : { path: NodePath.join(revisionDir, worker.fileName), code: worker.code };
  const textTargets = sortedTextFiles.map((file) => ({
    path: relativePosixToFsPath(revisionDir, file.relativePath),
    content: file.content,
  }));
  const mapError = (cause: unknown) =>
    new PluginOperationError({
      pluginId,
      operation,
      reason: "write_failed",
      cause,
    });

  for (const candidate of [
    historyRoot,
    pluginHistoryDir,
    revisionDir,
    manifestPath,
    cssPath,
    ...panelTargets.map((panel) => panel.path),
    ...(workerTarget === null ? [] : [workerTarget.path]),
    ...textTargets.map((file) => file.path),
  ]) {
    if (lstatOrNull(candidate)?.isSymbolicLink() === true) {
      return yield* new PluginOperationError({
        pluginId,
        operation,
        reason: "write_failed",
      });
    }
  }

  const existingManifest = lstatOrNull(manifestPath);
  const existingCss = lstatOrNull(cssPath);
  if (
    existingManifest?.isFile() &&
    existingCss?.isFile() &&
    panelTargets.every((panel) => lstatOrNull(panel.path)?.isFile() === true) &&
    (workerTarget === null || lstatOrNull(workerTarget.path)?.isFile() === true) &&
    textTargets.every((file) => lstatOrNull(file.path)?.isFile() === true)
  ) {
    return revision;
  }

  let maxExistingMtimeMs = 0;
  const existingEntries = yield* fs
    .readDirectory(pluginHistoryDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  for (const entry of existingEntries) {
    if (!isPluginRevision(entry) || entry === revision) continue;
    const stat = lstatOrNull(NodePath.join(pluginHistoryDir, entry));
    if (
      stat !== null &&
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      stat.mtimeMs > maxExistingMtimeMs
    ) {
      maxExistingMtimeMs = stat.mtimeMs;
    }
  }

  yield* fs.makeDirectory(revisionDir, { recursive: true }).pipe(Effect.mapError(mapError));
  yield* writeFileAtomic(fs, manifestPath, manifestText, mapError);
  yield* writeFileAtomic(fs, cssPath, cssText, mapError);
  for (const panel of panelTargets) {
    yield* writeFileAtomic(fs, panel.path, panel.html, mapError);
  }
  if (workerTarget !== null) {
    yield* writeFileAtomic(fs, workerTarget.path, workerTarget.code, mapError);
  }
  for (const textFile of textTargets) {
    yield* fs
      .makeDirectory(NodePath.dirname(textFile.path), { recursive: true })
      .pipe(Effect.mapError(mapError));
    yield* writeFileAtomic(fs, textFile.path, textFile.content, mapError);
  }

  // Keep mtimes strictly ordered across back-to-back writes within one OS timer tick.
  const writtenStat = lstatOrNull(revisionDir);
  if (
    writtenStat !== null &&
    maxExistingMtimeMs > 0 &&
    writtenStat.mtimeMs <= maxExistingMtimeMs &&
    maxExistingMtimeMs - writtenStat.mtimeMs < 60_000
  ) {
    const nextMtimeSeconds = (maxExistingMtimeMs + 1) / 1000;
    yield* Effect.try({
      try: () => NodeFS.utimesSync(revisionDir, nextMtimeSeconds, nextMtimeSeconds),
      catch: mapError,
    });
  }

  const entriesAfter = yield* fs
    .readDirectory(pluginHistoryDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const revisionDirs: Array<{ readonly name: string; readonly mtimeMs: number }> = [];
  for (const entry of entriesAfter) {
    if (!isPluginRevision(entry)) continue;
    const stat = lstatOrNull(NodePath.join(pluginHistoryDir, entry));
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    revisionDirs.push({ name: entry, mtimeMs: stat.mtimeMs });
  }
  if (revisionDirs.length > MAX_PLUGIN_HISTORY_REVISIONS) {
    revisionDirs.sort((left, right) => {
      if (left.name === revision) return -1;
      if (right.name === revision) return 1;
      return right.mtimeMs - left.mtimeMs;
    });
    for (const stale of revisionDirs.slice(MAX_PLUGIN_HISTORY_REVISIONS)) {
      yield* fs
        .remove(NodePath.join(pluginHistoryDir, stale.name), { recursive: true, force: true })
        .pipe(Effect.ignoreCause({ log: true }));
    }
  }
  return revision;
});

const realpathOrNull = (targetPath: string): string | null => {
  try {
    return NodeFS.realpathSync(targetPath);
  } catch {
    return null;
  }
};

const resolveManifestLocation = (
  folderPath: string,
  pluginRootReal: string,
):
  | { readonly ok: true; readonly manifestPath: string; readonly label: string }
  | { readonly ok: false; readonly problem: string } => {
  const candidates = [PLUGIN_MANIFEST_DIR, CLAUDE_PLUGIN_MANIFEST_DIR] as const;
  let allMissing = true;
  for (const dirName of candidates) {
    const manifestDir = NodePath.join(folderPath, dirName);
    if (lstatOrNull(manifestDir)?.isSymbolicLink() === true) {
      return { ok: false, problem: `Manifest directory ${dirName} cannot be a symlink.` };
    }
    const manifestPath = NodePath.join(manifestDir, PLUGIN_MANIFEST_FILE);
    const label = `${dirName}/${PLUGIN_MANIFEST_FILE}`;
    let manifestStat: NodeFS.Stats;
    try {
      manifestStat = NodeFS.lstatSync(manifestPath);
    } catch (error) {
      if (isMissingPath(error)) {
        continue;
      }
      return { ok: false, problem: `Manifest ${label} could not be accessed.` };
    }
    allMissing = false;
    if (manifestStat.isSymbolicLink()) {
      return { ok: false, problem: `Manifest ${label} cannot be a symlink.` };
    }
    if (!manifestStat.isFile()) {
      return { ok: false, problem: `Manifest ${label} is not a regular file.` };
    }
    const manifestDirReal = realpathOrNull(manifestDir);
    if (manifestDirReal === null || !isInsideDirectory(pluginRootReal, manifestDirReal, false)) {
      return {
        ok: false,
        problem: `Manifest directory ${dirName} must stay inside the plugin folder.`,
      };
    }
    return { ok: true, manifestPath, label };
  }
  return {
    ok: false,
    problem: allMissing
      ? "Missing .t3-plugin/plugin.json or .claude-plugin/plugin.json manifest."
      : "Manifest .t3-plugin/plugin.json could not be accessed.",
  };
};

const inspectPluginFolder = (
  pluginsDir: string,
  folderName: string,
  storedSetting: PluginSettingEntry | undefined,
  homeDirectory: string,
  runtimeState: PluginWorkerRuntimeState | undefined,
  defaultNetworkRestricted: boolean,
  isRepo = false,
  stateDir = NodePath.dirname(pluginsDir),
  mcpRuntimeStates: ReadonlyMap<string, PluginMcpServerRuntimeState> = new Map(),
): ScannedPlugin | null => {
  const storedEnabled = !isRepo && storedSetting?.enabled === true;
  if (folderName.startsWith(".")) return null;
  const folderPath = NodePath.join(pluginsDir, folderName);
  const folderStat = lstatOrNull(folderPath);
  if (folderStat === null) return null;
  if (folderStat.isSymbolicLink()) {
    return withProblem(folderName, "Plugin folder cannot be a symlink.");
  }
  if (!folderStat.isDirectory()) return null;
  if (!isPluginId(folderName)) {
    return withProblem(
      folderName,
      "Folder name must use lowercase letters, digits, and hyphens (max 64 characters).",
    );
  }

  const pluginRootReal = realpathOrNull(folderPath);
  if (pluginRootReal === null) {
    return withProblem(folderName, "Plugin folder could not be resolved.");
  }

  const manifestLoc = resolveManifestLocation(folderPath, pluginRootReal);
  if (!manifestLoc.ok) {
    return withProblem(folderName, manifestLoc.problem);
  }

  const rawManifest = readThemeFileGuarded(manifestLoc.manifestPath, MAX_PLUGIN_MANIFEST_BYTES);
  if (rawManifest === null) {
    return withProblem(
      folderName,
      `Manifest ${manifestLoc.label} could not be read or is too large.`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawManifest);
  } catch {
    return withProblem(folderName, `Manifest ${manifestLoc.label} is not valid JSON.`);
  }

  const decoded = decodePluginManifestExit(parsedJson);
  if (decoded._tag === "Failure") {
    const rawName = Predicate.hasProperty(parsedJson, "name") ? parsedJson.name : undefined;
    return withProblem(
      folderName,
      typeof rawName === "string" && !isPluginId(rawName)
        ? `Manifest name "${rawName}" is not a valid plugin id.`
        : `Manifest ${manifestLoc.label} has invalid or missing fields.`,
    );
  }
  const manifest = decoded.value;
  const emptyCssRevision = computePluginRevision(rawManifest, "");
  if (manifest.name !== folderName) {
    return withProblem(
      folderName,
      `Manifest name "${manifest.name}" does not match folder name "${folderName}".`,
      {},
      { revision: emptyCssRevision, rawManifest },
    );
  }

  const metadata: PluginMetadata = {
    ...(manifest.displayName !== undefined ? { displayName: manifest.displayName } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
  };
  const unsupported = detectUnsupportedParts(folderPath, parsedJson, manifest, isRepo);

  let css: string | undefined;
  let cssPath: string | undefined;
  if (!isRepo && manifest.css !== undefined) {
    const cssRead = readPluginFileGuarded(folderPath, pluginRootReal, manifest.css, {
      kind: "CSS",
      maxBytes: MAX_PLUGIN_CSS_BYTES,
      allowSubfolders: true,
      oversizeProblem: `CSS exceeds the ${THEME_CSS_MAX_LENGTH} character limit.`,
    });
    if (!cssRead.ok) {
      return withProblem(folderName, cssRead.problem, metadata, {
        revision: emptyCssRevision,
        unsupported,
        rawManifest,
      });
    }
    css = cssRead.content;
    cssPath = cssRead.path;
    if (css.length > THEME_CSS_MAX_LENGTH) {
      return withProblem(
        folderName,
        `CSS exceeds the ${THEME_CSS_MAX_LENGTH} character limit.`,
        metadata,
        {
          revision: computePluginRevision(rawManifest, css),
          unsupported,
          rawManifest,
          rawCss: css,
          cssPath,
        },
      );
    }
    if (themeCssLoadsRemoteFiles(css)) {
      return withProblem(
        folderName,
        "CSS cannot load remote files (@import, image-set(), or non-local url()).",
        metadata,
        {
          revision: computePluginRevision(rawManifest, css),
          unsupported,
          rawManifest,
          rawCss: css,
          cssPath,
        },
      );
    }
  }

  const panels: Array<ScannedPanel> = [];
  if (!isRepo && manifest.panels !== undefined) {
    for (const panel of manifest.panels) {
      const panelRead = readPluginFileGuarded(folderPath, pluginRootReal, panel.entry, {
        kind: "Panel",
        maxBytes: MCP_APP_MAX_HTML_BYTES,
        allowSubfolders: false,
        rootPattern: PANEL_ROOT_ENTRY_PATTERN,
      });
      if (!panelRead.ok) {
        return withProblem(folderName, panelRead.problem, metadata, {
          revision: computePluginRevision(
            rawManifest,
            css ?? "",
            panels.map((item) => item.html),
          ),
          unsupported,
          rawManifest,
          ...(css !== undefined ? { rawCss: css } : {}),
          ...(cssPath !== undefined ? { cssPath } : {}),
          ...(panels.length > 0
            ? { rawPanels: panels.map(({ fileName, html }) => ({ fileName, html })) }
            : {}),
        });
      }
      panels.push({
        id: panel.id,
        title: panel.title,
        fileName: NodePath.basename(panelRead.path),
        canonicalPath: panelRead.canonicalPath,
        html: panelRead.content,
      });
    }
  }

  let scannedWorker: ScannedWorker | undefined;
  let installedWorker: InstalledPluginWorker | undefined;
  let runtimeProblem: string | undefined;
  if (!isRepo && manifest.worker !== undefined) {
    const workerRead = readPluginFileGuarded(folderPath, pluginRootReal, manifest.worker.entry, {
      kind: "Worker",
      maxBytes: MAX_PLUGIN_WORKER_BYTES,
      allowSubfolders: false,
      rootPattern: WORKER_ROOT_ENTRY_PATTERN,
      oversizeProblem: `Worker code exceeds the ${PLUGIN_WORKER_CODE_MAX_CHARS} character limit.`,
    });
    if (!workerRead.ok) {
      return withProblem(folderName, workerRead.problem, metadata, {
        revision: computePluginRevision(
          rawManifest,
          css ?? "",
          panels.map((item) => item.html),
        ),
        unsupported,
        rawManifest,
        ...(css !== undefined ? { rawCss: css } : {}),
        ...(cssPath !== undefined ? { cssPath } : {}),
        ...(panels.length > 0
          ? { rawPanels: panels.map(({ fileName, html }) => ({ fileName, html })) }
          : {}),
      });
    }
    if (workerRead.content.length > PLUGIN_WORKER_CODE_MAX_CHARS) {
      return withProblem(
        folderName,
        `Worker code exceeds the ${PLUGIN_WORKER_CODE_MAX_CHARS} character limit.`,
        metadata,
        {
          revision: computePluginRevision(
            rawManifest,
            css ?? "",
            panels.map((item) => item.html),
            workerRead.content,
          ),
          unsupported,
          rawManifest,
          ...(css !== undefined ? { rawCss: css } : {}),
          ...(cssPath !== undefined ? { cssPath } : {}),
          ...(panels.length > 0
            ? { rawPanels: panels.map(({ fileName, html }) => ({ fileName, html })) }
            : {}),
          rawWorker: { fileName: NodePath.basename(workerRead.path), code: workerRead.content },
        },
      );
    }

    const declaredFolders = manifest.worker.folders ?? [];
    const network = manifest.worker.network === true;
    const powersHash = computePluginWorkerPowersHash({
      everyMinutes: manifest.worker.everyMinutes,
      folders: declaredFolders,
      network,
    });
    const codeHash = NodeCrypto.createHash("sha256")
      .update(workerRead.content)
      .digest("hex")
      .slice(0, 12);
    const resolvedFolders = declaredFolders.map((folder) => {
      const savedPath =
        storedSetting?.folders !== undefined && Object.hasOwn(storedSetting.folders, folder.id)
          ? storedSetting.folders[folder.id]
          : undefined;
      const validated =
        savedPath !== undefined
          ? validateAndCanonicalizeWorkerFolderPath(savedPath, homeDirectory)
          : ({ ok: false } as const);
      return {
        id: folder.id,
        label: folder.label,
        access: folder.access,
        realPath: validated.ok ? validated.path : null,
      };
    });
    const approved = storedSetting?.workerApproval === powersHash;
    const allFoldersValid = resolvedFolders.every((folder) => folder.realPath !== null);
    runtimeProblem = runtimeState?.runtimeProblem;
    const networkRestricted = runtimeState?.networkRestricted ?? defaultNetworkRestricted;
    let status: PluginWorkerStatus;
    if (!storedEnabled || runtimeProblem !== undefined) {
      status = "stopped";
    } else if (!approved) {
      status = "needs-approval";
    } else if (!allFoldersValid) {
      status = "needs-folder";
    } else {
      status = runtimeState?.status ?? "stopped";
    }
    const runnable = storedEnabled && approved && allFoldersValid && runtimeProblem === undefined;

    installedWorker = {
      ...(manifest.worker.everyMinutes !== undefined
        ? { everyMinutes: manifest.worker.everyMinutes }
        : {}),
      folders: resolvedFolders.map(({ id, label, access, realPath }) => ({
        id,
        label,
        access,
        path: realPath,
      })),
      network,
      status,
      networkRestricted,
      ...(runtimeState?.lastRunAt !== undefined ? { lastRunAt: runtimeState.lastRunAt } : {}),
      ...(runtimeState?.lastError !== undefined ? { lastError: runtimeState.lastError } : {}),
    };
    scannedWorker = {
      fileName: NodePath.basename(workerRead.path),
      path: workerRead.path,
      canonicalPath: workerRead.canonicalPath,
      code: workerRead.content,
      codeHash,
      powersHash,
      ...(manifest.worker.everyMinutes !== undefined
        ? { everyMinutes: manifest.worker.everyMinutes }
        : {}),
      folders: declaredFolders,
      network,
      desired: {
        pluginId: manifest.name,
        enabled: storedEnabled,
        runnable,
        pluginRootReal,
        entryCanonicalPath: workerRead.canonicalPath,
        workerCodeHash: codeHash,
        powersHash,
        ...(manifest.worker.everyMinutes !== undefined
          ? { everyMinutes: manifest.worker.everyMinutes }
          : {}),
        folders: resolvedFolders,
        network,
      },
    };
  }

  const textParts = scanPluginTextParts(folderPath, pluginRootReal);
  if (!textParts.ok) {
    return withProblem(folderName, textParts.problem, metadata, {
      revision: computePluginRevision(
        rawManifest,
        css ?? "",
        panels.map((item) => item.html),
        scannedWorker?.code,
        textParts.rawTextFiles,
      ),
      unsupported,
      rawManifest,
      ...(css !== undefined ? { rawCss: css } : {}),
      ...(cssPath !== undefined ? { cssPath } : {}),
      ...(panels.length > 0
        ? { rawPanels: panels.map(({ fileName, html }) => ({ fileName, html })) }
        : {}),
      ...(scannedWorker !== undefined
        ? { rawWorker: { fileName: scannedWorker.fileName, code: scannedWorker.code } }
        : {}),
      rawTextFiles: textParts.rawTextFiles,
    });
  }

  const externalParts = scanPluginExternalParts({
    folderPath,
    pluginRootReal,
    manifestMcpServers: manifest.mcpServers,
    manifestHooks: manifest.hooks,
    isRepo,
  });
  const combinedRawTextFilesByPath = new Map<string, string>();
  for (const file of textParts.rawTextFiles) {
    combinedRawTextFilesByPath.set(file.relativePath, file.content);
  }
  for (const file of externalParts.rawFiles) {
    combinedRawTextFilesByPath.set(file.relativePath, file.content);
  }
  const combinedRawTextFiles = sortRawTextFiles(
    [...combinedRawTextFilesByPath.entries()].map(([relativePath, content]) => ({
      relativePath,
      content,
    })),
  );

  const pluginDataDir = pluginDataDirFor(stateDir, folderName);
  const externalPowersHash = externalParts.externalPowersHash;
  const externalApproved =
    !isRepo &&
    externalPowersHash !== undefined &&
    storedSetting?.externalApproval === externalPowersHash;

  let externalStatus: PluginExternalStatus | undefined;
  if (!isRepo && externalParts.hasRunnableExternal) {
    if (!storedEnabled || runtimeProblem !== undefined) {
      externalStatus = "stopped";
    } else if (!externalApproved) {
      externalStatus = "needs-approval";
    } else {
      externalStatus = "approved";
    }
  }

  const installedMcpServers: Array<InstalledPluginMcpServer> = [];
  const mcpDesiredSpecs: Array<PluginMcpServerDesiredSpec> = [];
  if (!isRepo) {
    for (const server of externalParts.mcpServers) {
      let serverStatus: PluginMcpServerStatus;
      let toolCount: number | undefined;
      let truncatedTools: boolean | undefined;
      let serverError: string | undefined;
      if (server.notRunnableReason !== undefined || server.runnable === undefined) {
        serverStatus = "not-runnable";
      } else if (!storedEnabled || runtimeProblem !== undefined) {
        serverStatus = "stopped";
      } else if (!externalApproved) {
        serverStatus = "needs-approval";
      } else {
        const runtime = mcpRuntimeStates.get(`${folderName}\0${server.name}`);
        serverStatus = runtime?.status ?? "starting";
        toolCount = runtime?.toolCount;
        truncatedTools = runtime?.truncatedTools;
        serverError = runtime?.error;
        const configKey = computePluginMcpServerConfigKey(server, pluginRootReal, pluginDataDir);
        mcpDesiredSpecs.push({
          pluginId: manifest.name,
          ...(manifest.displayName !== undefined
            ? { pluginDisplayName: manifest.displayName }
            : {}),
          pluginRootReal,
          pluginDataDir,
          serverName: server.name,
          configKey,
          transport:
            server.runnable.kind === "stdio"
              ? {
                  kind: "stdio",
                  command: server.runnable.command,
                  args: server.runnable.args,
                  env: server.runnable.env,
                }
              : {
                  kind: "http",
                  url: server.runnable.url,
                  headers: server.runnable.headers,
                },
          ...(server.runnable.timeoutMs !== undefined
            ? { timeoutMs: server.runnable.timeoutMs }
            : {}),
        });
      }
      installedMcpServers.push({
        name: server.name,
        transport: server.transport,
        target: server.target,
        status: serverStatus,
        ...(toolCount !== undefined ? { toolCount } : {}),
        ...(truncatedTools === true ? { truncatedTools: true } : {}),
        ...(serverError !== undefined ? { error: serverError } : {}),
        ...(server.notRunnableReason !== undefined ? { reason: server.notRunnableReason } : {}),
      });
    }
  }

  const commandNames = textParts.skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => skill.name);
  const skillNames = textParts.skills
    .filter((skill) => skill.modelInvocable)
    .map((skill) => skill.name);
  const contributes: Array<PluginContribution> = [];
  if (css !== undefined) contributes.push("css");
  if (panels.length > 0) contributes.push("panel");
  if (scannedWorker !== undefined) contributes.push("worker");
  if (commandNames.length > 0) contributes.push("command");
  if (skillNames.length > 0) contributes.push("skill");
  if (textParts.instructions !== undefined) contributes.push("instructions");
  if (installedMcpServers.length > 0) contributes.push("mcp");
  if (externalParts.hookSummaries.length > 0) contributes.push("hook");
  if (externalParts.agents.length > 0) contributes.push("agent");

  const revision = computePluginRevision(
    rawManifest,
    css ?? "",
    panels.map((panel) => panel.html),
    scannedWorker?.code,
    combinedRawTextFiles,
  );
  if (contributes.length === 0) {
    const emptyProblem =
      externalParts.partProblems.length > 0
        ? externalParts.partProblems.join(" ")
        : unsupported.length > 0
          ? isRepo
            ? "Repo plugin has no supported parts (only skills, commands, agents, and AGENTS.md are supported in repo plugins)."
            : "Plugin has no supported parts in T3 yet."
          : "Plugin manifest must define css, panels, a worker, skills, commands, agents, MCP servers, hooks, or AGENTS.md.";
    return withProblem(folderName, emptyProblem, metadata, {
      revision,
      unsupported,
      rawManifest,
      ...(combinedRawTextFiles.length > 0 ? { rawTextFiles: combinedRawTextFiles } : {}),
    });
  }

  const installedPanels: ReadonlyArray<InstalledPluginPanel> | undefined =
    panels.length > 0 ? panels.map(({ id, title }) => ({ id, title })) : undefined;

  return {
    plugin: {
      id: folderName,
      ...metadata,
      enabled: runtimeProblem !== undefined ? false : storedEnabled,
      contributes,
      ...(installedPanels !== undefined ? { panels: installedPanels } : {}),
      ...(installedWorker !== undefined ? { worker: installedWorker } : {}),
      ...(commandNames.length > 0 ? { commands: commandNames } : {}),
      ...(skillNames.length > 0 ? { skills: skillNames } : {}),
      ...(installedMcpServers.length > 0 ? { mcpServers: installedMcpServers } : {}),
      ...(externalParts.hookSummaries.length > 0 ? { hooks: externalParts.hookSummaries } : {}),
      ...(externalParts.agentSummaries.length > 0 ? { agents: externalParts.agentSummaries } : {}),
      ...(externalStatus !== undefined ? { externalStatus } : {}),
      ...(externalParts.partProblems.length > 0
        ? { partProblems: externalParts.partProblems }
        : {}),
      ...(unsupported.length > 0 ? { unsupported } : {}),
      revision,
      ...(runtimeProblem !== undefined ? { problem: runtimeProblem } : {}),
    },
    pluginRootReal,
    pluginDataDir,
    ...(css !== undefined ? { css, rawCss: css } : {}),
    ...(cssPath !== undefined ? { cssPath } : {}),
    ...(panels.length > 0
      ? {
          panels,
          rawPanels: panels.map(({ fileName, html }) => ({ fileName, html })),
        }
      : {}),
    ...(scannedWorker !== undefined
      ? {
          worker: scannedWorker,
          rawWorker: { fileName: scannedWorker.fileName, code: scannedWorker.code },
        }
      : {}),
    ...(textParts.skills.length > 0 ? { skills: textParts.skills } : {}),
    ...(textParts.instructions !== undefined ? { instructions: textParts.instructions } : {}),
    ...(externalParts.mcpServers.length > 0 ? { mcpServers: externalParts.mcpServers } : {}),
    ...(mcpDesiredSpecs.length > 0 ? { mcpDesiredSpecs } : {}),
    ...(externalParts.hooks !== undefined ? { hooks: externalParts.hooks } : {}),
    ...(externalParts.agents.length > 0 ? { agents: externalParts.agents } : {}),
    ...(externalPowersHash !== undefined ? { externalPowersHash } : {}),
    externalApproved,
    ...(manifest.mcpServers !== undefined ? { manifestMcpServers: manifest.mcpServers } : {}),
    ...(manifest.hooks !== undefined ? { manifestHooks: manifest.hooks } : {}),
    ...(combinedRawTextFiles.length > 0 ? { rawTextFiles: combinedRawTextFiles } : {}),
    rawManifest,
  };
};

const toEnvironmentCommands = (
  skills: ReadonlyArray<ScannedSkill> | undefined,
): ReadonlyArray<EnvironmentPluginCommand> | undefined => {
  if (skills === undefined || skills.length === 0) return undefined;
  const commands = skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => ({
      name: skill.name,
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      ...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
    }));
  return commands.length > 0 ? commands : undefined;
};

const buildEnvironmentPlugin = (
  scanned: ScannedPlugin,
  projectId?: ProjectId,
): EnvironmentPlugin | null => {
  if (
    !scanned.plugin.enabled ||
    scanned.plugin.problem !== undefined ||
    !isPluginId(scanned.plugin.id)
  ) {
    return null;
  }
  const activeCommands = toEnvironmentCommands(scanned.skills);
  if (projectId !== undefined) {
    if (activeCommands === undefined) return null;
    return {
      id: scanned.plugin.id,
      ...(scanned.plugin.displayName !== undefined
        ? { displayName: scanned.plugin.displayName }
        : {}),
      css: "",
      commands: activeCommands,
      projectId,
    };
  }
  const activePanels =
    scanned.panels !== undefined && scanned.panels.length > 0
      ? scanned.panels.map(({ id, title }) => ({ id, title }))
      : undefined;
  if (
    scanned.css === undefined &&
    activePanels === undefined &&
    scanned.plugin.worker === undefined &&
    activeCommands === undefined &&
    scanned.plugin.mcpServers === undefined &&
    scanned.plugin.externalStatus === undefined
  ) {
    return null;
  }
  return {
    id: scanned.plugin.id,
    // Only commands and panels show the name (menus, keybinding labels); CSS-only snapshots stay compact.
    ...((activeCommands !== undefined || activePanels !== undefined) &&
    scanned.plugin.displayName !== undefined
      ? { displayName: scanned.plugin.displayName }
      : {}),
    css: scanned.css ?? "",
    ...(activePanels !== undefined ? { panels: activePanels } : {}),
    ...(scanned.plugin.worker !== undefined ? { worker: scanned.plugin.worker } : {}),
    ...(activeCommands !== undefined ? { commands: activeCommands } : {}),
    ...(scanned.plugin.mcpServers !== undefined ? { mcpServers: scanned.plugin.mcpServers } : {}),
    ...(scanned.plugin.externalStatus !== undefined
      ? { externalStatus: scanned.plugin.externalStatus }
      : {}),
  };
};

interface CachedRepoProjectScan {
  readonly workspaceRoot: string;
  readonly fingerprint: string;
  readonly scanned: ReadonlyArray<ScannedPlugin>;
}

const fingerprintRepoPluginsDir = (
  repoPluginsDir: string,
): { readonly fingerprint: string; readonly maxMtimeMs: number } | null => {
  const dotT3Dir = NodePath.dirname(repoPluginsDir);
  const dotT3Stat = lstatOrNull(dotT3Dir);
  if (dotT3Stat === null || dotT3Stat.isSymbolicLink() || !dotT3Stat.isDirectory()) return null;
  const dirStat = lstatOrNull(repoPluginsDir);
  if (dirStat === null || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;

  const parts: Array<string> = [`root:${dirStat.mtimeMs}`];
  let maxMtimeMs = dirStat.mtimeMs;
  const record = (label: string, targetPath: string): NodeFS.Stats | null => {
    const stat = lstatOrNull(targetPath);
    if (stat === null) return null;
    if (stat.mtimeMs > maxMtimeMs) maxMtimeMs = stat.mtimeMs;
    parts.push(
      `${label}:${stat.isSymbolicLink() ? "L" : stat.isDirectory() ? "D" : "F"}:${stat.mtimeMs}:${stat.size}`,
    );
    return stat;
  };

  let examined = 0;
  for (const folderName of readDirEntriesSorted(repoPluginsDir)) {
    if (folderName.startsWith(".")) continue;
    const folderPath = NodePath.join(repoPluginsDir, folderName);
    const folderStat = record(`d/${folderName}`, folderPath);
    if (folderStat === null || (!folderStat.isDirectory() && !folderStat.isSymbolicLink()))
      continue;
    examined += 1;
    if (examined > REPO_PLUGIN_MAX_FOLDERS) break;
    if (folderStat.isSymbolicLink()) continue;

    record(
      `m1/${folderName}`,
      NodePath.join(folderPath, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE),
    );
    record(
      `m2/${folderName}`,
      NodePath.join(folderPath, CLAUDE_PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE),
    );
    record(`a/${folderName}`, NodePath.join(folderPath, PLUGIN_INSTRUCTIONS_FILE));
    record(`h/${folderName}`, NodePath.join(folderPath, "hooks", "hooks.json"));
    record(`c/${folderName}`, NodePath.join(folderPath, ".mcp.json"));
    const agentsDir = NodePath.join(folderPath, PLUGIN_AGENTS_DIR);
    const agentsStat = record(`g/${folderName}`, agentsDir);
    if (agentsStat !== null && !agentsStat.isSymbolicLink() && agentsStat.isDirectory()) {
      for (const child of readDirEntriesSorted(agentsDir)) {
        if (child.startsWith(".") || !child.endsWith(".md")) continue;
        record(`gf/${folderName}/${child}`, NodePath.join(agentsDir, child));
      }
    }

    const skillsDir = NodePath.join(folderPath, PLUGIN_SKILLS_DIR);
    const skillsStat = record(`s/${folderName}`, skillsDir);
    if (skillsStat !== null && !skillsStat.isSymbolicLink() && skillsStat.isDirectory()) {
      for (const child of readDirEntriesSorted(skillsDir)) {
        if (child.startsWith(".")) continue;
        const childDir = NodePath.join(skillsDir, child);
        const childStat = record(`sd/${folderName}/${child}`, childDir);
        if (childStat !== null && !childStat.isSymbolicLink() && childStat.isDirectory()) {
          record(`sf/${folderName}/${child}`, NodePath.join(childDir, PLUGIN_SKILL_FILE));
        }
      }
    }

    const commandsDir = NodePath.join(folderPath, PLUGIN_COMMANDS_DIR);
    const commandsStat = record(`k/${folderName}`, commandsDir);
    if (commandsStat !== null && !commandsStat.isSymbolicLink() && commandsStat.isDirectory()) {
      for (const child of readDirEntriesSorted(commandsDir)) {
        if (child.startsWith(".") || !child.endsWith(".md")) continue;
        record(`kf/${folderName}/${child}`, NodePath.join(commandsDir, child));
      }
    }
  }

  return { fingerprint: parts.join("|"), maxMtimeMs };
};

const applyRepoPluginApproval = (
  scanned: ScannedPlugin,
  projectId: ProjectId,
  approvedHash: string | undefined,
): ScannedPlugin => {
  const hasProblem = scanned.plugin.problem !== undefined;
  let repoStatus: RepoPluginStatus;
  if (approvedHash === undefined) {
    repoStatus = "off";
  } else if (!hasProblem && approvedHash === scanned.plugin.revision) {
    repoStatus = "on";
  } else {
    repoStatus = "changed";
  }
  const enabled = !hasProblem && repoStatus === "on";
  return {
    ...scanned,
    plugin: {
      ...scanned.plugin,
      enabled,
      projectId,
      repoStatus,
    },
  };
};

const scanRepoPluginsForProject = (
  projectId: ProjectId,
  workspaceRoot: string,
  approvedByPlugin: Readonly<Record<string, string>> | undefined,
  homeDirectory: string,
  defaultNetworkRestricted: boolean,
  cache: Map<string, CachedRepoProjectScan>,
  nowMs: number,
): ReadonlyArray<ScannedPlugin> => {
  const repoPluginsDir = NodePath.join(workspaceRoot, ".t3", "plugins");
  const fp = fingerprintRepoPluginsDir(repoPluginsDir);
  if (fp === null) {
    cache.delete(projectId);
    return [];
  }

  // Skip the mtime cache for very recent writes so same-tick same-size edits cannot serve stale data.
  const canUseCache = nowMs - fp.maxMtimeMs >= RACY_MTIME_WINDOW_MS;
  const cached = cache.get(projectId);
  let baseScanned: ReadonlyArray<ScannedPlugin>;
  if (
    canUseCache &&
    cached !== undefined &&
    cached.workspaceRoot === workspaceRoot &&
    cached.fingerprint === fp.fingerprint
  ) {
    baseScanned = cached.scanned;
  } else {
    const entries = readDirEntriesSorted(repoPluginsDir);
    const scannedList: Array<ScannedPlugin> = [];
    let examined = 0;
    for (const folderName of entries) {
      const scanned = inspectPluginFolder(
        repoPluginsDir,
        folderName,
        undefined,
        homeDirectory,
        undefined,
        defaultNetworkRestricted,
        true,
      );
      if (scanned === null) continue;
      examined += 1;
      if (examined > REPO_PLUGIN_MAX_FOLDERS) break;
      scannedList.push(scanned);
    }
    baseScanned = scannedList;
    if (canUseCache) {
      cache.set(projectId, { workspaceRoot, fingerprint: fp.fingerprint, scanned: baseScanned });
    } else {
      cache.delete(projectId);
    }
  }

  return baseScanned.map((scanned) => {
    const approvedHash =
      approvedByPlugin !== undefined && Object.hasOwn(approvedByPlugin, scanned.plugin.id)
        ? approvedByPlugin[scanned.plugin.id]
        : undefined;
    return applyRepoPluginApproval(scanned, projectId, approvedHash);
  });
};

const scanPlugins = Effect.fnUntraced(function* (
  pluginsDir: string,
  stateDir: string,
  pluginSettings: Readonly<Record<string, PluginSettingEntry>>,
  homeDirectory: string,
  runtimeStates: ReadonlyMap<string, PluginWorkerRuntimeState>,
  mcpRuntimeStates: ReadonlyMap<string, PluginMcpServerRuntimeState>,
  defaultNetworkRestricted: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(pluginsDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const plugins: Array<InstalledPlugin> = [];
  const active: Array<EnvironmentPlugin> = [];
  const activeUserScanned: Array<ScannedPlugin> = [];
  const panelEntries = new Map<string, ReadonlyMap<string, string>>();
  const workerSpecs: Array<PluginWorkerDesiredSpec> = [];
  const mcpSpecs: Array<PluginMcpServerDesiredSpec> = [];
  const externalPowersHashes = new Map<string, string>();
  let examined = 0;

  for (const folderName of entries.toSorted()) {
    const storedSetting = Object.hasOwn(pluginSettings, folderName)
      ? pluginSettings[folderName]
      : undefined;
    const scanned = inspectPluginFolder(
      pluginsDir,
      folderName,
      storedSetting,
      homeDirectory,
      runtimeStates.get(folderName),
      defaultNetworkRestricted,
      false,
      stateDir,
      mcpRuntimeStates,
    );
    if (scanned === null) continue;

    examined += 1;
    if (examined > MAX_PLUGIN_FOLDERS) {
      yield* Effect.logWarning("ignoring plugin folders past the limit", {
        path: pluginsDir,
        limit: MAX_PLUGIN_FOLDERS,
      });
      break;
    }

    plugins.push(scanned.plugin);
    if (scanned.worker !== undefined) {
      workerSpecs.push(scanned.worker.desired);
    }
    if (scanned.externalPowersHash !== undefined) {
      externalPowersHashes.set(scanned.plugin.id, scanned.externalPowersHash);
    }
    if (
      scanned.plugin.enabled &&
      scanned.plugin.problem === undefined &&
      isPluginId(scanned.plugin.id)
    ) {
      activeUserScanned.push(scanned);
      if (scanned.mcpDesiredSpecs !== undefined && scanned.mcpDesiredSpecs.length > 0) {
        mcpSpecs.push(...scanned.mcpDesiredSpecs);
      }
      const envPlugin = buildEnvironmentPlugin(scanned);
      if (envPlugin !== null) {
        active.push(envPlugin);
      }
      if (scanned.panels !== undefined && scanned.panels.length > 0) {
        panelEntries.set(
          scanned.plugin.id,
          new Map(scanned.panels.map((panel) => [panel.id, panel.canonicalPath])),
        );
      }
    }
  }

  return {
    plugins,
    active,
    panelEntries,
    workerSpecs,
    mcpSpecs,
    externalPowersHashes,
    activeUserScanned,
  };
});

const make = Effect.gen(function* () {
  const { pluginsDir, stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const projectStore = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const defaultNetworkRestricted = detectPluginWorkerRuntimeCapabilities().networkRestricted;

  const changes = yield* PubSub.sliding<PluginSnapshot>(1);
  const workerSpecChanges = yield* PubSub.unbounded<PluginSnapshot>();
  const mcpSpecChanges = yield* PubSub.unbounded<PluginSnapshot>();
  const runtimeStates = new Map<string, PluginWorkerRuntimeState>();
  const mcpRuntimeStates = new Map<string, PluginMcpServerRuntimeState>();
  const repoScanCache = new Map<string, CachedRepoProjectScan>();
  const published = yield* Ref.make<PluginSnapshot>({
    seq: 0,
    workerSeq: 0,
    mcpSeq: 0,
    plugins: [],
    active: [],
    panelEntries: new Map(),
    workerSpecs: [],
    mcpSpecs: [],
    externalPowersHashes: new Map(),
    activeUserScanned: [],
  });
  const refreshSemaphore = yield* Semaphore.make(1);
  const mutationSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const scanRepoProjects = Effect.fn("PluginRegistry.scanRepoProjects")(function* (
    repoPluginSettings: Readonly<Record<string, Readonly<Record<string, string>>>>,
    onlyApprovedProjects: boolean,
  ) {
    if (Option.isNone(projectStore)) {
      return [] as ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly scanned: ReadonlyArray<ScannedPlugin>;
      }>;
    }
    const approvedProjectIds = Object.keys(repoPluginSettings) as Array<ProjectId>;
    if (onlyApprovedProjects && approvedProjectIds.length === 0) {
      return [];
    }
    const projects = yield* projectStore.value
      .list(onlyApprovedProjects ? { projectIds: approvedProjectIds } : undefined)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<ProjectStore.ProjectRow> => []));
    const nowMs = yield* Clock.currentTimeMillis;
    return projects.map((project) => ({
      projectId: project.projectId,
      scanned: scanRepoPluginsForProject(
        project.projectId,
        project.workspaceRoot,
        Object.hasOwn(repoPluginSettings, project.projectId)
          ? repoPluginSettings[project.projectId]
          : undefined,
        homeDirectory,
        defaultNetworkRestricted,
        repoScanCache,
        nowMs,
      ),
    }));
  });

  const hasRepoPluginWithId = Effect.fn("PluginRegistry.hasRepoPluginWithId")(function* (
    id: string,
  ) {
    if (Option.isNone(projectStore)) return false;
    const projects = yield* projectStore.value
      .list()
      .pipe(Effect.orElseSucceed((): ReadonlyArray<ProjectStore.ProjectRow> => []));
    const nowMs = yield* Clock.currentTimeMillis;
    return projects.some((project) =>
      scanRepoPluginsForProject(
        project.projectId,
        project.workspaceRoot,
        undefined,
        homeDirectory,
        defaultNetworkRestricted,
        repoScanCache,
        nowMs,
      ).some((entry) => entry.plugin.id === id),
    );
  });

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const currentSettings = yield* settings.getSettings.pipe(
        Effect.map((current) => ({
          plugins: current.plugins as Readonly<Record<string, PluginSettingEntry>>,
          repoPlugins: current.repoPlugins as Readonly<
            Record<string, Readonly<Record<string, string>>>
          >,
        })),
        Effect.orElseSucceed(() => ({
          plugins: {} as Readonly<Record<string, PluginSettingEntry>>,
          repoPlugins: {} as Readonly<Record<string, Readonly<Record<string, string>>>>,
        })),
      );
      const {
        plugins,
        active,
        panelEntries,
        workerSpecs,
        mcpSpecs,
        externalPowersHashes,
        activeUserScanned,
      } = yield* scanPlugins(
        pluginsDir,
        stateDir,
        currentSettings.plugins,
        homeDirectory,
        runtimeStates,
        mcpRuntimeStates,
        defaultNetworkRestricted,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const repoProjects = yield* scanRepoProjects(currentSettings.repoPlugins, true);
      const combinedActive: Array<EnvironmentPlugin> = [...active];
      for (const { projectId, scanned } of repoProjects) {
        for (const item of scanned) {
          if (!item.plugin.enabled || item.plugin.problem !== undefined) continue;
          const envPlugin = buildEnvironmentPlugin(item, projectId);
          if (envPlugin !== null) {
            combinedActive.push(envPlugin);
          }
        }
      }
      const [activeChanged, workerSpecsChanged, mcpSpecsChanged, next] = yield* Ref.modify(
        published,
        (
          previous,
        ): readonly [readonly [boolean, boolean, boolean, PluginSnapshot], PluginSnapshot] => {
          const sameActive = Equal.equals(previous.active, combinedActive);
          const samePlugins = Equal.equals(previous.plugins, plugins);
          const sameWorkerSpecs = Equal.equals(previous.workerSpecs, workerSpecs);
          const sameMcpSpecs = Equal.equals(previous.mcpSpecs, mcpSpecs);
          const updated: PluginSnapshot = {
            seq: sameActive ? previous.seq : previous.seq + 1,
            workerSeq: sameWorkerSpecs ? previous.workerSeq : previous.workerSeq + 1,
            mcpSeq: sameMcpSpecs ? previous.mcpSeq : previous.mcpSeq + 1,
            plugins,
            active: combinedActive,
            panelEntries,
            workerSpecs,
            mcpSpecs,
            externalPowersHashes,
            activeUserScanned,
          };
          if (sameActive && samePlugins && sameWorkerSpecs && sameMcpSpecs) {
            return [[false, false, false, updated], updated];
          }
          return [[!sameActive, !sameWorkerSpecs, !sameMcpSpecs, updated], updated];
        },
      );
      if (activeChanged) {
        yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      }
      if (workerSpecsChanged) {
        yield* PubSub.publish(workerSpecChanges, next).pipe(Effect.asVoid);
      }
      if (mcpSpecsChanged) {
        yield* PubSub.publish(mcpSpecChanges, next).pipe(Effect.asVoid);
      }
      return next;
    }),
  );

  yield* fs.makeDirectory(pluginsDir, { recursive: true }).pipe(Effect.ignoreCause({ log: true }));

  const watchDirectory = (directory: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const markReady = () => Deferred.doneUnsafe(ready, Exit.void);
        const events = fs.watch(directory, { recursive: true, onReady: markReady }).pipe(
          Stream.as(undefined),
          Stream.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Stream.empty,
          ),
          Stream.ignoreCause({ log: true }),
          Stream.ensuring(Effect.sync(markReady)),
        );
        return Stream.merge(events, Stream.fromEffect(Deferred.await(ready)));
      }),
    );

  const watchEvents = watchDirectoryPath(pluginsDir, watchDirectory(pluginsDir)).pipe(
    // A save emits several events, and fs.watch can fire before content is flushed.
    Stream.debounce(Duration.millis(100)),
  );

  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause({ log: true }))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );
  const pluginSettingChanges = settings.streamChanges.pipe(
    Stream.map((current) => [current.plugins, current.repoPlugins] as const),
    Stream.changesWith(Equal.equals),
  );
  yield* Stream.runForEach(pluginSettingChanges, () =>
    refresh.pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);

  const list = Effect.fn("PluginRegistry.list")(function* () {
    const snapshot = yield* refresh;
    const repoPluginSettings = yield* settings.getSettings.pipe(
      Effect.map(
        (current) =>
          current.repoPlugins as Readonly<Record<string, Readonly<Record<string, string>>>>,
      ),
      Effect.orElseSucceed((): Readonly<Record<string, Readonly<Record<string, string>>>> => ({})),
    );
    const repoProjects = yield* scanRepoProjects(repoPluginSettings, false);
    const repoPlugins = repoProjects.flatMap((entry) => entry.scanned.map((item) => item.plugin));
    return { pluginsDir, plugins: snapshot.plugins, repoPlugins };
  });

  const read: PluginRegistry["Service"]["read"] = Effect.fn("PluginRegistry.read")(function* (id) {
    return yield* mutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (!isPluginId(id)) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "read",
            reason: "invalid_id",
          });
        }
        const folderPath = NodePath.join(pluginsDir, id);
        const folderStat = lstatOrNull(folderPath);
        if (folderStat === null) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "read",
            reason: "not_found",
          });
        }
        if (folderStat.isSymbolicLink()) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "read",
            reason: "has_problem",
          });
        }
        if (!folderStat.isDirectory()) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "read",
            reason: "not_found",
          });
        }
        const scanned = inspectPluginFolder(
          pluginsDir,
          id,
          undefined,
          homeDirectory,
          undefined,
          defaultNetworkRestricted,
        );
        if (scanned === null) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "read",
            reason: "not_found",
          });
        }
        if (scanned.plugin.problem !== undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "read",
            reason: "has_problem",
          });
        }
        const readableMcpServers = (scanned.mcpServers ?? []).flatMap((server) =>
          server.writeConfig === undefined ? [] : ([[server.name, server.writeConfig]] as const),
        );
        return {
          ...(scanned.plugin.displayName !== undefined
            ? { displayName: scanned.plugin.displayName }
            : {}),
          ...(scanned.plugin.description !== undefined
            ? { description: scanned.plugin.description }
            : {}),
          ...(scanned.plugin.version !== undefined ? { version: scanned.plugin.version } : {}),
          ...(scanned.css !== undefined ? { css: scanned.css } : {}),
          ...(scanned.panels !== undefined && scanned.panels.length > 0
            ? {
                panels: scanned.panels.map(({ id: panelId, title, html }) => ({
                  id: panelId,
                  title,
                  html,
                })),
              }
            : {}),
          ...(scanned.worker !== undefined
            ? {
                worker: {
                  code: scanned.worker.code,
                  ...(scanned.worker.everyMinutes !== undefined
                    ? { everyMinutes: scanned.worker.everyMinutes }
                    : {}),
                  ...(scanned.worker.folders.length > 0 ? { folders: scanned.worker.folders } : {}),
                  ...(scanned.worker.network ? { network: true } : {}),
                },
              }
            : {}),
          ...(scanned.skills !== undefined && scanned.skills.length > 0
            ? {
                skills: scanned.skills.map((skill) => ({
                  name: skill.name,
                  ...(skill.description !== undefined ? { description: skill.description } : {}),
                  ...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
                  userInvocable: skill.userInvocable,
                  modelInvocable: skill.modelInvocable,
                  body: skill.body,
                })),
              }
            : {}),
          ...(scanned.instructions !== undefined ? { instructions: scanned.instructions } : {}),
          ...(readableMcpServers.length > 0
            ? { mcpServers: Object.fromEntries(readableMcpServers) }
            : {}),
          ...(scanned.hooks !== undefined ? { hooks: scanned.hooks } : {}),
          ...(scanned.agents !== undefined && scanned.agents.length > 0
            ? {
                agents: scanned.agents.map((agent) => ({
                  name: agent.name,
                  description: agent.description,
                  ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
                  ...(agent.disallowedTools !== undefined
                    ? { disallowedTools: agent.disallowedTools }
                    : {}),
                  ...(agent.model !== undefined ? { model: agent.model } : {}),
                  ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
                  ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
                  body: agent.prompt,
                })),
              }
            : {}),
        };
      }),
    );
  });

  const write: PluginRegistry["Service"]["write"] = Effect.fn("PluginRegistry.write")(
    function* (input) {
      return yield* mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (!isPluginId(input.id)) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_id",
            });
          }

          const resolvedRoot = NodePath.resolve(pluginsDir);
          const folderPath = NodePath.resolve(pluginsDir, input.id);
          if (!isInsideDirectory(resolvedRoot, folderPath, false)) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_id",
            });
          }
          const folderStat = lstatOrNull(folderPath);
          const created = folderStat === null;
          const existing = created
            ? null
            : inspectPluginFolder(
                pluginsDir,
                input.id,
                undefined,
                homeDirectory,
                undefined,
                defaultNetworkRestricted,
                false,
              );
          const preserveExisting = existing !== null && existing.plugin.problem === undefined;

          const effectiveDisplayName =
            input.displayName !== undefined
              ? input.displayName
              : preserveExisting
                ? existing.plugin.displayName
                : undefined;
          const effectiveDescription =
            input.description !== undefined
              ? input.description
              : preserveExisting
                ? existing.plugin.description
                : undefined;
          const effectiveVersion =
            input.version !== undefined
              ? input.version
              : preserveExisting
                ? existing.plugin.version
                : undefined;
          const effectiveCss =
            input.css !== undefined ? input.css : preserveExisting ? existing.css : undefined;
          const effectivePanels =
            input.panels !== undefined
              ? input.panels
              : preserveExisting && existing.panels !== undefined && existing.panels.length > 0
                ? existing.panels.map(({ id: panelId, title, html }) => ({
                    id: panelId,
                    title,
                    html,
                  }))
                : undefined;
          const effectiveWorker: PluginWorkerContent | undefined =
            input.worker !== undefined
              ? input.worker
              : preserveExisting && existing.worker !== undefined
                ? {
                    code: existing.worker.code,
                    ...(existing.worker.everyMinutes !== undefined
                      ? { everyMinutes: existing.worker.everyMinutes }
                      : {}),
                    ...(existing.worker.folders.length > 0
                      ? { folders: existing.worker.folders }
                      : {}),
                    ...(existing.worker.network ? { network: true } : {}),
                  }
                : undefined;

          const effectiveInstructions =
            input.instructions !== undefined
              ? input.instructions.trim().length === 0
                ? undefined
                : input.instructions
              : preserveExisting
                ? existing.instructions
                : undefined;
          if (
            effectiveInstructions !== undefined &&
            Buffer.byteLength(effectiveInstructions, "utf8") > PLUGIN_INSTRUCTIONS_MAX_BYTES
          ) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_instructions",
            });
          }

          const existingMcpPath = preserveExisting
            ? resolveManifestExternalJsonPath(existing.manifestMcpServers)
            : null;
          const existingHooksPath = preserveExisting
            ? resolveManifestExternalJsonPath(existing.manifestHooks)
            : null;

          let nextSkillFiles: Array<RawPluginTextFile>;
          if (input.skills !== undefined) {
            if (input.skills.length > PLUGIN_MAX_SKILLS) {
              return yield* new PluginOperationError({
                pluginId: input.id,
                operation: "write",
                reason: "invalid_skill",
              });
            }
            const seenNames = new Set<string>();
            nextSkillFiles = [];
            for (const skill of input.skills) {
              if (!isPluginId(skill.name) || seenNames.has(skill.name)) {
                return yield* new PluginOperationError({
                  pluginId: input.id,
                  operation: "write",
                  reason: "invalid_skill",
                });
              }
              seenNames.add(skill.name);
              const content = formatPluginSkillMarkdown(skill);
              if (Buffer.byteLength(content, "utf8") > PLUGIN_SKILL_MAX_BYTES) {
                return yield* new PluginOperationError({
                  pluginId: input.id,
                  operation: "write",
                  reason: "invalid_skill",
                });
              }
              nextSkillFiles.push({
                relativePath: `${PLUGIN_SKILLS_DIR}/${skill.name}/${PLUGIN_SKILL_FILE}`,
                content,
              });
            }
          } else {
            nextSkillFiles = preserveExisting
              ? (existing.rawTextFiles ?? []).filter(
                  (file) =>
                    file.relativePath.startsWith(`${PLUGIN_SKILLS_DIR}/`) ||
                    file.relativePath.startsWith(`${PLUGIN_COMMANDS_DIR}/`),
                )
              : [];
          }

          let nextAgentFiles: Array<RawPluginTextFile>;
          if (input.agents !== undefined) {
            if (input.agents.length > PLUGIN_MAX_AGENTS) {
              return yield* new PluginOperationError({
                pluginId: input.id,
                operation: "write",
                reason: "invalid_agent",
              });
            }
            const seenAgentNames = new Set<string>();
            nextAgentFiles = [];
            for (const agent of input.agents) {
              if (
                !isPluginId(agent.name) ||
                seenAgentNames.has(agent.name) ||
                agent.description.trim().length === 0
              ) {
                return yield* new PluginOperationError({
                  pluginId: input.id,
                  operation: "write",
                  reason: "invalid_agent",
                });
              }
              seenAgentNames.add(agent.name);
              const content = formatPluginAgentMarkdown(agent);
              if (Buffer.byteLength(content, "utf8") > PLUGIN_AGENT_MAX_BYTES) {
                return yield* new PluginOperationError({
                  pluginId: input.id,
                  operation: "write",
                  reason: "invalid_agent",
                });
              }
              nextAgentFiles.push({
                relativePath: `${PLUGIN_AGENTS_DIR}/${agent.name}.md`,
                content,
              });
            }
          } else {
            nextAgentFiles = preserveExisting
              ? (existing.rawTextFiles ?? []).filter((file) =>
                  file.relativePath.startsWith(`${PLUGIN_AGENTS_DIR}/`),
                )
              : [];
          }

          let nextMcpFiles: Array<RawPluginTextFile>;
          let nextManifestMcpServers: unknown;
          if (input.mcpServers !== undefined) {
            const validated = validateAndSerializePluginMcpWrite(input.mcpServers);
            if (!validated.ok) {
              return yield* new PluginOperationError({
                pluginId: input.id,
                operation: "write",
                reason: "invalid_mcp",
              });
            }
            nextMcpFiles =
              validated.json === null
                ? []
                : [{ relativePath: PLUGIN_MCP_FILE, content: validated.json }];
            nextManifestMcpServers = undefined;
          } else {
            nextManifestMcpServers = preserveExisting ? existing.manifestMcpServers : undefined;
            nextMcpFiles = preserveExisting
              ? (existing.rawTextFiles ?? []).filter(
                  (file) =>
                    file.relativePath === PLUGIN_MCP_FILE ||
                    (existingMcpPath !== null && file.relativePath === existingMcpPath),
                )
              : [];
          }

          let nextHooksFiles: Array<RawPluginTextFile>;
          let nextManifestHooks: unknown;
          if (input.hooks !== undefined) {
            const validated = validateAndSerializePluginHooksWrite(input.hooks);
            if (!validated.ok) {
              return yield* new PluginOperationError({
                pluginId: input.id,
                operation: "write",
                reason: "invalid_hooks",
              });
            }
            nextHooksFiles =
              validated.json === null
                ? []
                : [{ relativePath: PLUGIN_HOOKS_FILE, content: validated.json }];
            nextManifestHooks = undefined;
          } else {
            nextManifestHooks = preserveExisting ? existing.manifestHooks : undefined;
            nextHooksFiles = preserveExisting
              ? (existing.rawTextFiles ?? []).filter(
                  (file) =>
                    file.relativePath === PLUGIN_HOOKS_FILE ||
                    (existingHooksPath !== null && file.relativePath === existingHooksPath),
                )
              : [];
          }

          const hasCss = effectiveCss !== undefined;
          const hasPanels = effectivePanels !== undefined && effectivePanels.length > 0;
          const hasWorker = effectiveWorker !== undefined;
          const hasSkills = nextSkillFiles.length > 0;
          const hasInstructions = effectiveInstructions !== undefined;
          const hasAgents = nextAgentFiles.length > 0;
          const hasMcp = nextMcpFiles.length > 0 || nextManifestMcpServers !== undefined;
          const hasHooks = nextHooksFiles.length > 0 || nextManifestHooks !== undefined;
          if (
            !hasCss &&
            !hasPanels &&
            !hasWorker &&
            !hasSkills &&
            !hasInstructions &&
            !hasAgents &&
            !hasMcp &&
            !hasHooks
          ) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason:
                input.mcpServers !== undefined
                  ? "invalid_mcp"
                  : input.hooks !== undefined
                    ? "invalid_hooks"
                    : input.agents !== undefined
                      ? "invalid_agent"
                      : input.skills !== undefined
                        ? "invalid_skill"
                        : "invalid_panel",
            });
          }
          if (
            effectiveCss !== undefined &&
            (effectiveCss.length > THEME_CSS_MAX_LENGTH || themeCssLoadsRemoteFiles(effectiveCss))
          ) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_css",
            });
          }
          if (effectivePanels !== undefined) {
            if (effectivePanels.length === 0 || effectivePanels.length > PLUGIN_MAX_PANELS) {
              return yield* new PluginOperationError({
                pluginId: input.id,
                operation: "write",
                reason: "invalid_panel",
              });
            }
            for (const panel of effectivePanels) {
              if (
                !isPluginId(panel.id) ||
                panel.html.length > PLUGIN_PANEL_HTML_MAX_CHARS ||
                Buffer.byteLength(panel.html, "utf8") > MCP_APP_MAX_HTML_BYTES
              ) {
                return yield* new PluginOperationError({
                  pluginId: input.id,
                  operation: "write",
                  reason: "invalid_panel",
                });
              }
            }
          }
          if (effectiveWorker !== undefined) {
            if (
              effectiveWorker.code.length > PLUGIN_WORKER_CODE_MAX_CHARS ||
              Buffer.byteLength(effectiveWorker.code, "utf8") > MAX_PLUGIN_WORKER_BYTES ||
              (effectiveWorker.folders !== undefined &&
                effectiveWorker.folders.length > PLUGIN_WORKER_MAX_FOLDERS)
            ) {
              return yield* new PluginOperationError({
                pluginId: input.id,
                operation: "write",
                reason: "invalid_worker",
              });
            }
          }

          const manifestDecoded = decodePluginManifestExit({
            name: input.id,
            ...(effectiveDisplayName !== undefined ? { displayName: effectiveDisplayName } : {}),
            ...(effectiveDescription !== undefined ? { description: effectiveDescription } : {}),
            ...(effectiveVersion !== undefined ? { version: effectiveVersion } : {}),
            ...(effectiveCss !== undefined ? { css: `./${PLUGIN_CSS_FILE}` } : {}),
            ...(effectivePanels !== undefined
              ? {
                  panels: effectivePanels.map((panel) => ({
                    id: panel.id,
                    title: panel.title,
                    entry: `./${panel.id}.html`,
                  })),
                }
              : {}),
            ...(effectiveWorker !== undefined
              ? {
                  worker: {
                    entry: `./${PLUGIN_WORKER_FILE}`,
                    ...(effectiveWorker.everyMinutes !== undefined
                      ? { everyMinutes: effectiveWorker.everyMinutes }
                      : {}),
                    ...(effectiveWorker.folders !== undefined
                      ? { folders: effectiveWorker.folders }
                      : {}),
                    ...(effectiveWorker.network !== undefined
                      ? { network: effectiveWorker.network }
                      : {}),
                  },
                }
              : {}),
            ...(nextManifestMcpServers !== undefined ? { mcpServers: nextManifestMcpServers } : {}),
            ...(nextManifestHooks !== undefined ? { hooks: nextManifestHooks } : {}),
          });
          if (manifestDecoded._tag === "Failure") {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason:
                effectiveWorker !== undefined
                  ? "invalid_worker"
                  : effectivePanels !== undefined
                    ? "invalid_panel"
                    : "has_problem",
            });
          }
          const manifestText = `${yield* encodePluginManifestJson(manifestDecoded.value).pipe(
            Effect.mapError(
              () =>
                new PluginOperationError({
                  pluginId: input.id,
                  operation: "write",
                  reason: "has_problem",
                }),
            ),
          )}\n`;

          const manifestDir = NodePath.join(folderPath, PLUGIN_MANIFEST_DIR);
          const manifestPath = NodePath.join(manifestDir, PLUGIN_MANIFEST_FILE);
          const cssPath =
            effectiveCss !== undefined ? NodePath.join(folderPath, PLUGIN_CSS_FILE) : null;
          const panelWrites = (effectivePanels ?? []).map((panel) => ({
            fileName: `${panel.id}.html`,
            targetPath: NodePath.join(folderPath, `${panel.id}.html`),
            html: panel.html,
          }));
          const workerPath =
            effectiveWorker !== undefined ? NodePath.join(folderPath, PLUGIN_WORKER_FILE) : null;
          const nextTextFilesMap = new Map<string, string>();
          for (const file of [
            ...(effectiveInstructions !== undefined
              ? [{ relativePath: PLUGIN_INSTRUCTIONS_FILE, content: effectiveInstructions }]
              : []),
            ...nextSkillFiles,
            ...nextAgentFiles,
            ...nextMcpFiles,
            ...nextHooksFiles,
          ]) {
            nextTextFilesMap.set(file.relativePath, file.content);
          }
          const nextTextFiles = sortRawTextFiles(
            [...nextTextFilesMap.entries()].map(([relativePath, content]) => ({
              relativePath,
              content,
            })),
          );
          const textFilesToWrite = sortRawTextFiles([
            ...(input.instructions !== undefined && effectiveInstructions !== undefined
              ? [{ relativePath: PLUGIN_INSTRUCTIONS_FILE, content: effectiveInstructions }]
              : []),
            ...(input.skills !== undefined ? nextSkillFiles : []),
            ...(input.agents !== undefined ? nextAgentFiles : []),
            ...(input.mcpServers !== undefined ? nextMcpFiles : []),
            ...(input.hooks !== undefined ? nextHooksFiles : []),
          ]);
          if (
            !isExistingTargetSafe(
              folderPath,
              cssPath,
              panelWrites.map((panel) => panel.targetPath),
              workerPath,
              nextTextFiles.map((file) => file.relativePath),
            )
          ) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "has_problem",
            });
          }

          let before: string | undefined;
          const previousCssPath = existing?.cssPath ?? null;
          const previousPanelFileNames = (existing?.rawPanels ?? []).map((panel) => panel.fileName);
          const previousWorkerPath = existing?.worker?.path ?? null;
          const previousTextRelativePaths = (existing?.rawTextFiles ?? []).map(
            (file) => file.relativePath,
          );
          if (!created && existing?.rawManifest !== undefined) {
            before = yield* saveHistoryRevision(
              fs,
              stateDir,
              input.id,
              existing.rawManifest,
              existing.rawCss ?? "",
              existing.rawPanels ?? [],
              "write",
              existing.rawWorker,
              existing.rawTextFiles ?? [],
            );
          }

          const mapWriteError = (cause: unknown) =>
            new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "write_failed",
              cause,
            });
          yield* fs
            .makeDirectory(manifestDir, { recursive: true })
            .pipe(Effect.mapError(mapWriteError));
          yield* writeFileAtomic(fs, manifestPath, manifestText, mapWriteError);
          if (cssPath !== null && effectiveCss !== undefined) {
            yield* writeFileAtomic(fs, cssPath, effectiveCss, mapWriteError);
          }
          for (const panel of panelWrites) {
            yield* writeFileAtomic(fs, panel.targetPath, panel.html, mapWriteError);
          }
          if (workerPath !== null && effectiveWorker !== undefined) {
            yield* writeFileAtomic(fs, workerPath, effectiveWorker.code, mapWriteError);
          }
          for (const textFile of textFilesToWrite) {
            const targetPath = relativePosixToFsPath(folderPath, textFile.relativePath);
            yield* fs
              .makeDirectory(NodePath.dirname(targetPath), { recursive: true })
              .pipe(Effect.mapError(mapWriteError));
            yield* writeFileAtomic(fs, targetPath, textFile.content, mapWriteError);
          }
          yield* cleanupStalePluginFiles(
            fs,
            folderPath,
            previousPanelFileNames,
            new Set(panelWrites.map((panel) => panel.fileName)),
            previousCssPath,
            cssPath,
            previousWorkerPath,
            workerPath,
            previousTextRelativePaths,
            new Set(nextTextFiles.map((file) => file.relativePath)),
          );

          const after = yield* saveHistoryRevision(
            fs,
            stateDir,
            input.id,
            manifestText,
            effectiveCss ?? "",
            panelWrites.map(({ fileName, html }) => ({ fileName, html })),
            "write",
            effectiveWorker === undefined
              ? undefined
              : { fileName: PLUGIN_WORKER_FILE, code: effectiveWorker.code },
            nextTextFiles,
          );
          const updated = yield* refresh;
          const plugin = updated.plugins.find((candidate) => candidate.id === input.id);
          if (plugin === undefined) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "write_failed",
            });
          }
          return {
            plugin,
            created,
            ...(before !== undefined ? { before } : {}),
            after,
          };
        }),
      );
    },
  );

  const restore: PluginRegistry["Service"]["restore"] = Effect.fn("PluginRegistry.restore")(
    function* (id, revision, enable, options) {
      return yield* mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (options?.projectId !== undefined) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "repo_plugin_readonly",
            });
          }
          if (!isPluginId(id)) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "invalid_id",
            });
          }
          if (!isPluginRevision(revision)) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "not_found",
            });
          }
          const historyRoot = NodePath.resolve(stateDir, PLUGINS_HISTORY_DIR_NAME);
          const pluginHistoryDir = NodePath.resolve(historyRoot, id);
          const revisionDir = NodePath.resolve(pluginHistoryDir, revision);
          if (
            !isInsideDirectory(historyRoot, pluginHistoryDir, false) ||
            !isInsideDirectory(pluginHistoryDir, revisionDir, false)
          ) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "not_found",
            });
          }
          const histManifestPath = NodePath.join(revisionDir, PLUGIN_MANIFEST_FILE);
          const histCssPath = NodePath.join(revisionDir, PLUGIN_CSS_FILE);
          for (const candidate of [
            historyRoot,
            pluginHistoryDir,
            revisionDir,
            histManifestPath,
            histCssPath,
          ]) {
            if (lstatOrNull(candidate)?.isSymbolicLink() === true) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "has_problem",
              });
            }
          }
          const revStat = lstatOrNull(revisionDir);
          if (revStat === null || !revStat.isDirectory()) {
            const folderStat = lstatOrNull(NodePath.resolve(pluginsDir, id));
            if (folderStat === null && (yield* hasRepoPluginWithId(id))) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "repo_plugin_readonly",
              });
            }
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "not_found",
            });
          }
          const manifestText = readThemeFileGuarded(histManifestPath, MAX_PLUGIN_MANIFEST_BYTES);
          const cssText = readThemeFileGuarded(histCssPath, MAX_PLUGIN_CSS_BYTES);
          if (manifestText === null || cssText === null) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "not_found",
            });
          }
          const decoded = decodePluginManifestJsonExit(manifestText);
          if (decoded._tag === "Failure" || decoded.value.name !== id) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "has_problem",
            });
          }
          const extraHistoryJsonPaths = [
            resolveManifestExternalJsonPath(decoded.value.mcpServers),
            resolveManifestExternalJsonPath(decoded.value.hooks),
          ].filter((entry): entry is string => entry !== null);
          const historyTextFiles = readHistoryTextFiles(revisionDir, extraHistoryJsonPaths);
          if (!historyTextFiles.ok) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "has_problem",
            });
          }
          if (
            decoded.value.css === undefined &&
            decoded.value.panels === undefined &&
            decoded.value.worker === undefined &&
            decoded.value.mcpServers === undefined &&
            decoded.value.hooks === undefined &&
            historyTextFiles.files.length === 0
          ) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "has_problem",
            });
          }
          const folderPath = NodePath.resolve(pluginsDir, id);
          const targetCssPath =
            decoded.value.css === undefined
              ? null
              : resolveSafePluginFilePath(folderPath, decoded.value.css, true);
          if (decoded.value.css !== undefined) {
            if (targetCssPath === null) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "has_problem",
              });
            }
            if (cssText.length > THEME_CSS_MAX_LENGTH || themeCssLoadsRemoteFiles(cssText)) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "invalid_css",
              });
            }
          }

          const panelRestores: Array<{
            readonly fileName: string;
            readonly targetPath: string;
            readonly html: string;
          }> = [];
          for (const panel of decoded.value.panels ?? []) {
            const targetPanelPath = resolveSafePluginFilePath(
              folderPath,
              panel.entry,
              false,
              PANEL_ROOT_ENTRY_PATTERN,
            );
            if (targetPanelPath === null) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "has_problem",
              });
            }
            const fileName = NodePath.basename(targetPanelPath);
            const histPanelPath = NodePath.resolve(revisionDir, fileName);
            if (
              !isInsideDirectory(revisionDir, histPanelPath, false) ||
              lstatOrNull(histPanelPath)?.isSymbolicLink() === true
            ) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "has_problem",
              });
            }
            const html = readThemeFileGuarded(histPanelPath, MCP_APP_MAX_HTML_BYTES);
            if (html === null) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "not_found",
              });
            }
            panelRestores.push({ fileName, targetPath: targetPanelPath, html });
          }

          let workerRestore:
            | {
                readonly fileName: string;
                readonly targetPath: string;
                readonly code: string;
                readonly powersHash: string;
              }
            | undefined;
          if (decoded.value.worker !== undefined) {
            const targetWorkerPath = resolveSafePluginFilePath(
              folderPath,
              decoded.value.worker.entry,
              false,
              WORKER_ROOT_ENTRY_PATTERN,
            );
            if (targetWorkerPath === null) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "has_problem",
              });
            }
            const fileName = NodePath.basename(targetWorkerPath);
            const histWorkerPath = NodePath.resolve(revisionDir, fileName);
            if (
              !isInsideDirectory(revisionDir, histWorkerPath, false) ||
              lstatOrNull(histWorkerPath)?.isSymbolicLink() === true
            ) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "has_problem",
              });
            }
            const code = readThemeFileGuarded(histWorkerPath, MAX_PLUGIN_WORKER_BYTES);
            if (code === null) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "not_found",
              });
            }
            if (code.length > PLUGIN_WORKER_CODE_MAX_CHARS) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "restore",
                reason: "invalid_worker",
              });
            }
            workerRestore = {
              fileName,
              targetPath: targetWorkerPath,
              code,
              powersHash: computePluginWorkerPowersHash(decoded.value.worker),
            };
          }

          const manifestDir = NodePath.join(folderPath, PLUGIN_MANIFEST_DIR);
          const manifestPath = NodePath.join(manifestDir, PLUGIN_MANIFEST_FILE);
          if (
            !isExistingTargetSafe(
              folderPath,
              targetCssPath,
              panelRestores.map((panel) => panel.targetPath),
              workerRestore?.targetPath ?? null,
              historyTextFiles.files.map((file) => file.relativePath),
            )
          ) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "has_problem",
            });
          }
          let previousCssPath: string | null = null;
          let previousPanelFileNames: ReadonlyArray<string> = [];
          let previousWorkerPath: string | null = null;
          let previousTextRelativePaths: ReadonlyArray<string> = [];
          if (lstatOrNull(folderPath) !== null) {
            const existing = inspectPluginFolder(
              pluginsDir,
              id,
              undefined,
              homeDirectory,
              undefined,
              defaultNetworkRestricted,
            );
            previousCssPath = existing?.cssPath ?? null;
            previousPanelFileNames = (existing?.rawPanels ?? []).map((panel) => panel.fileName);
            previousWorkerPath = existing?.worker?.path ?? null;
            previousTextRelativePaths = (existing?.rawTextFiles ?? []).map(
              (file) => file.relativePath,
            );
            if (existing?.rawManifest !== undefined) {
              yield* saveHistoryRevision(
                fs,
                stateDir,
                id,
                existing.rawManifest,
                existing.rawCss ?? "",
                existing.rawPanels ?? [],
                "restore",
                existing.rawWorker,
                existing.rawTextFiles ?? [],
              );
            }
          }

          const mapWriteError = (cause: unknown) =>
            new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "write_failed",
              cause,
            });
          yield* fs
            .makeDirectory(manifestDir, { recursive: true })
            .pipe(Effect.mapError(mapWriteError));
          yield* writeFileAtomic(fs, manifestPath, manifestText, mapWriteError);
          if (targetCssPath !== null) {
            yield* fs
              .makeDirectory(NodePath.dirname(targetCssPath), { recursive: true })
              .pipe(Effect.mapError(mapWriteError));
            yield* writeFileAtomic(fs, targetCssPath, cssText, mapWriteError);
          }
          for (const panel of panelRestores) {
            yield* writeFileAtomic(fs, panel.targetPath, panel.html, mapWriteError);
          }
          if (workerRestore !== undefined) {
            yield* writeFileAtomic(fs, workerRestore.targetPath, workerRestore.code, mapWriteError);
          }
          for (const textFile of historyTextFiles.files) {
            const targetPath = relativePosixToFsPath(folderPath, textFile.relativePath);
            yield* fs
              .makeDirectory(NodePath.dirname(targetPath), { recursive: true })
              .pipe(Effect.mapError(mapWriteError));
            yield* writeFileAtomic(fs, targetPath, textFile.content, mapWriteError);
          }
          yield* cleanupStalePluginFiles(
            fs,
            folderPath,
            previousPanelFileNames,
            new Set(panelRestores.map((panel) => panel.fileName)),
            previousCssPath,
            targetCssPath,
            previousWorkerPath,
            workerRestore?.targetPath ?? null,
            previousTextRelativePaths,
            new Set(historyTextFiles.files.map((file) => file.relativePath)),
          );

          if (enable === true) {
            const restoredExternalHash =
              options?.approveExternal === true
                ? inspectPluginFolder(
                    pluginsDir,
                    id,
                    undefined,
                    homeDirectory,
                    undefined,
                    defaultNetworkRestricted,
                    false,
                    stateDir,
                  )?.externalPowersHash
                : undefined;
            yield* settings
              .updateSettings({
                plugins: {
                  [id]: {
                    enabled: true,
                    ...(options?.approveWorker === true && workerRestore !== undefined
                      ? { workerApproval: workerRestore.powersHash }
                      : {}),
                    ...(options?.approveExternal === true && restoredExternalHash !== undefined
                      ? { externalApproval: restoredExternalHash }
                      : {}),
                  },
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new PluginOperationError({
                      pluginId: id,
                      operation: "restore",
                      reason: "settings_failed",
                      cause,
                    }),
                ),
              );
          }

          const updated = yield* refresh;
          const plugin = updated.plugins.find((candidate) => candidate.id === id);
          if (plugin === undefined) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "write_failed",
            });
          }
          return { plugin };
        }),
      );
    },
  );

  const setEnabled: PluginRegistry["Service"]["setEnabled"] = Effect.fn(
    "PluginRegistry.setEnabled",
  )(function* (id, enabled, options) {
    return yield* mutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (!isPluginId(id)) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setEnabled",
            reason: "invalid_id",
          });
        }
        if (options?.projectId !== undefined) {
          const projectId = options.projectId;
          const projectOption = Option.isSome(projectStore)
            ? yield* projectStore.value
                .get(projectId)
                .pipe(
                  Effect.orElseSucceed((): Option.Option<ProjectStore.ProjectRow> => Option.none()),
                )
            : Option.none();
          if (Option.isNone(projectOption)) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "setEnabled",
              reason: "not_found",
            });
          }
          repoScanCache.delete(projectId);
          const currentSettings = yield* settings.getSettings.pipe(
            Effect.map(
              (current) =>
                current.repoPlugins as Readonly<Record<string, Readonly<Record<string, string>>>>,
            ),
            Effect.orElseSucceed(
              (): Readonly<Record<string, Readonly<Record<string, string>>>> => ({}),
            ),
          );
          const nowMs = yield* Clock.currentTimeMillis;
          const scanned = scanRepoPluginsForProject(
            projectId,
            projectOption.value.workspaceRoot,
            Object.hasOwn(currentSettings, projectId) ? currentSettings[projectId] : undefined,
            homeDirectory,
            defaultNetworkRestricted,
            repoScanCache,
            nowMs,
          );
          const target = scanned.find((candidate) => candidate.plugin.id === id);
          if (target === undefined) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "setEnabled",
              reason: "not_found",
            });
          }
          if (enabled) {
            if (target.plugin.problem !== undefined) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "setEnabled",
                reason: "has_problem",
              });
            }
            if (
              target.plugin.revision === undefined ||
              options.revision === undefined ||
              options.revision !== target.plugin.revision
            ) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "setEnabled",
                reason: "changed",
              });
            }
            yield* settings
              .updateSettings({
                repoPlugins: {
                  [projectId]: {
                    [id]: target.plugin.revision,
                  },
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new PluginOperationError({
                      pluginId: id,
                      operation: "setEnabled",
                      reason: "settings_failed",
                      cause,
                    }),
                ),
              );
          } else {
            yield* settings
              .updateSettings({
                repoPlugins: {
                  [projectId]: {
                    [id]: null,
                  },
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new PluginOperationError({
                      pluginId: id,
                      operation: "setEnabled",
                      reason: "settings_failed",
                      cause,
                    }),
                ),
              );
          }
          yield* refresh;
          return {
            plugin: {
              ...target.plugin,
              enabled,
              repoStatus: enabled ? ("on" as const) : ("off" as const),
            },
          };
        }
        const current = yield* refresh;
        const target = current.plugins.find((plugin) => plugin.id === id);
        if (target === undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setEnabled",
            reason: "not_found",
          });
        }
        if (enabled && target.problem !== undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setEnabled",
            reason: "has_problem",
          });
        }
        if (options?.revision !== undefined && options.revision !== target.revision) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setEnabled",
            reason: "changed",
          });
        }
        const targetSpec = current.workerSpecs.find((spec) => spec.pluginId === id);
        const targetExternalHash = current.externalPowersHashes.get(id);
        yield* settings
          .updateSettings({
            plugins: {
              [id]: {
                enabled,
                ...(enabled && options?.approveWorker === true && targetSpec !== undefined
                  ? { workerApproval: targetSpec.powersHash }
                  : {}),
                ...(enabled && options?.approveExternal === true && targetExternalHash !== undefined
                  ? { externalApproval: targetExternalHash }
                  : {}),
              },
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PluginOperationError({
                  pluginId: id,
                  operation: "setEnabled",
                  reason: "settings_failed",
                  cause,
                }),
            ),
          );
        const updated = yield* refresh;
        const plugin = updated.plugins.find((candidate) => candidate.id === id) ?? {
          ...target,
          enabled: target.problem === undefined && enabled,
        };
        return { plugin };
      }),
    );
  });

  const approveWorker: PluginRegistry["Service"]["approveWorker"] = Effect.fn(
    "PluginRegistry.approveWorker",
  )(function* (id, revision) {
    return yield* mutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (!isPluginId(id)) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "approveWorker",
            reason: "invalid_id",
          });
        }
        const current = yield* refresh;
        const target = current.plugins.find((plugin) => plugin.id === id);
        if (target === undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "approveWorker",
            reason: "not_found",
          });
        }
        if (target.problem !== undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "approveWorker",
            reason: "has_problem",
          });
        }
        if (revision !== undefined && revision !== target.revision) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "approveWorker",
            reason: "changed",
          });
        }
        const targetSpec = current.workerSpecs.find((spec) => spec.pluginId === id);
        if (targetSpec === undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "approveWorker",
            reason: "not_found",
          });
        }
        yield* settings
          .updateSettings({
            plugins: {
              [id]: { workerApproval: targetSpec.powersHash },
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PluginOperationError({
                  pluginId: id,
                  operation: "approveWorker",
                  reason: "settings_failed",
                  cause,
                }),
            ),
          );
        const updated = yield* refresh;
        const plugin = updated.plugins.find((candidate) => candidate.id === id) ?? target;
        return { plugin };
      }),
    );
  });

  const setWorkerFolder: PluginRegistry["Service"]["setWorkerFolder"] = Effect.fn(
    "PluginRegistry.setWorkerFolder",
  )(function* (id, folderId, rawPath) {
    return yield* mutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (!isPluginId(id)) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setWorkerFolder",
            reason: "invalid_id",
          });
        }
        const current = yield* refresh;
        const target = current.plugins.find((plugin) => plugin.id === id);
        if (target === undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setWorkerFolder",
            reason: "not_found",
          });
        }
        if (target.problem !== undefined) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setWorkerFolder",
            reason: "has_problem",
          });
        }
        const targetSpec = current.workerSpecs.find((spec) => spec.pluginId === id);
        if (
          targetSpec === undefined ||
          !targetSpec.folders.some((folder) => folder.id === folderId)
        ) {
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "setWorkerFolder",
            reason: "not_found",
          });
        }
        let nextPath: string | null = null;
        if (rawPath !== null) {
          const validated = validateAndCanonicalizeWorkerFolderPath(rawPath, homeDirectory);
          if (!validated.ok) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "setWorkerFolder",
              reason: "invalid_folder",
            });
          }
          nextPath = validated.path;
        }
        yield* settings
          .updateSettings({
            plugins: {
              [id]: { folders: { [folderId]: nextPath } },
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PluginOperationError({
                  pluginId: id,
                  operation: "setWorkerFolder",
                  reason: "settings_failed",
                  cause,
                }),
            ),
          );
        const updated = yield* refresh;
        const plugin = updated.plugins.find((candidate) => candidate.id === id) ?? target;
        return { plugin };
      }),
    );
  });

  const uninstall: PluginRegistry["Service"]["uninstall"] = Effect.fn("PluginRegistry.uninstall")(
    function* (id, projectId) {
      return yield* mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (projectId !== undefined) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "uninstall",
              reason: "repo_plugin_readonly",
            });
          }
          if (!isSafeFolderName(id)) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "uninstall",
              reason: "invalid_id",
            });
          }
          const resolvedRoot = NodePath.resolve(pluginsDir);
          const source = NodePath.resolve(pluginsDir, id);
          if (!isInsideDirectory(resolvedRoot, source, false)) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "uninstall",
              reason: "invalid_id",
            });
          }
          const sourceStat = lstatOrNull(source);
          if (sourceStat === null || (!sourceStat.isDirectory() && !sourceStat.isSymbolicLink())) {
            if (yield* hasRepoPluginWithId(id)) {
              return yield* new PluginOperationError({
                pluginId: id,
                operation: "uninstall",
                reason: "repo_plugin_readonly",
              });
            }
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "uninstall",
              reason: "not_found",
            });
          }

          const archiveRoot = NodePath.join(stateDir, PLUGINS_ARCHIVE_DIR_NAME);
          yield* fs.makeDirectory(archiveRoot, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new PluginOperationError({
                  pluginId: id,
                  operation: "uninstall",
                  reason: "archive_failed",
                  cause,
                }),
            ),
          );

          const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
          let archivedTo = NodePath.join(archiveRoot, `${id}-${stamp}`);
          let suffix = 1;
          while (pathExists(archivedTo)) {
            archivedTo = NodePath.join(archiveRoot, `${id}-${stamp}-${suffix}`);
            suffix += 1;
          }

          yield* fs.rename(source, archivedTo).pipe(
            Effect.mapError(
              (cause) =>
                new PluginOperationError({
                  pluginId: id,
                  operation: "uninstall",
                  reason: "archive_failed",
                  cause,
                }),
            ),
          );

          if (isPluginId(id)) {
            yield* settings.updateSettings({ plugins: { [id]: null } }).pipe(
              Effect.tapError(() => fs.rename(archivedTo, source).pipe(Effect.ignore)),
              Effect.mapError(
                (cause) =>
                  new PluginOperationError({
                    pluginId: id,
                    operation: "uninstall",
                    reason: "settings_failed",
                    cause,
                  }),
              ),
            );
          }

          runtimeStates.delete(id);
          const mcpPrefix = `${id}\0`;
          for (const key of mcpRuntimeStates.keys()) {
            if (key.startsWith(mcpPrefix)) {
              mcpRuntimeStates.delete(key);
            }
          }
          yield* refresh;
          return { id, archivedTo };
        }),
      );
    },
  );

  const reportWorkerRuntime: PluginRegistry["Service"]["reportWorkerRuntime"] = Effect.fnUntraced(
    // Untraced: called on supervisor runtime status transitions; refresh owns the span.
    function* (pluginId, state) {
      if (state === null) {
        runtimeStates.delete(pluginId);
      } else {
        runtimeStates.set(pluginId, state);
      }
      yield* refresh.pipe(Effect.asVoid);
    },
  );

  const reportMcpRuntime: PluginRegistry["Service"]["reportMcpRuntime"] = Effect.fnUntraced(
    // Untraced: called on proxy runtime status transitions; refresh owns the span.
    function* (pluginId, serverName, state) {
      const key = `${pluginId}\0${serverName}`;
      if (state === null) {
        mcpRuntimeStates.delete(key);
      } else {
        mcpRuntimeStates.set(key, state);
      }
      yield* refresh.pipe(Effect.asVoid);
    },
  );

  const resolvePanelEntry: PluginRegistry["Service"]["resolvePanelEntry"] = Effect.fn(
    "PluginRegistry.resolvePanelEntry",
  )(function* (pluginId, panelId) {
    if (!isPluginId(pluginId) || !isPluginId(panelId)) {
      return yield* new PluginOperationError({
        pluginId,
        operation: "resolvePanelEntry",
        reason: "not_found",
      });
    }
    const snapshot = yield* refresh;
    const entryPath = snapshot.panelEntries.get(pluginId)?.get(panelId);
    if (entryPath === undefined) {
      return yield* new PluginOperationError({
        pluginId,
        operation: "resolvePanelEntry",
        reason: "not_found",
      });
    }
    return entryPath;
  });

  const getTurnContext: PluginRegistry["Service"]["getTurnContext"] = Effect.fn(
    "PluginRegistry.getTurnContext",
  )(function* (projectId) {
    // User plugins are watched, so the published snapshot is current; repo folders are not.
    const snapshot = yield* Ref.get(published);
    const repoApprovals = yield* settings.getSettings.pipe(
      Effect.map((current) =>
        Object.hasOwn(current.repoPlugins, projectId) ? current.repoPlugins[projectId] : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const repoProjects =
      repoApprovals === undefined
        ? []
        : yield* scanRepoProjects({ [projectId]: repoApprovals }, true);
    const activePlugins = [
      ...snapshot.activeUserScanned,
      ...repoProjects.flatMap(({ scanned }) =>
        scanned.filter((item) => item.plugin.enabled && item.plugin.problem === undefined),
      ),
    ];
    const contextPlugins: Array<ProjectContextPlugin> = [];
    const commandsByKey = new Map<string, PluginSlashCommandEntry>();
    const hooksByEvent: Record<string, Array<PluginHookMatcherGroup>> = {};
    const agentsByKey = new Map<string, ProviderAdapterV2PluginAgent>();

    for (const scanned of activePlugins) {
      const modelSkills = (scanned.skills ?? []).filter((skill) => skill.modelInvocable);
      if (scanned.instructions !== undefined || modelSkills.length > 0) {
        contextPlugins.push({
          id: scanned.plugin.id,
          ...(scanned.plugin.displayName !== undefined
            ? { displayName: scanned.plugin.displayName }
            : {}),
          ...(scanned.instructions !== undefined ? { instructions: scanned.instructions } : {}),
          ...(modelSkills.length > 0
            ? {
                skills: modelSkills.map((skill) => ({
                  name: skill.name,
                  ...(skill.description !== undefined ? { description: skill.description } : {}),
                  path: skill.filePath,
                })),
              }
            : {}),
        });
      }
      const pluginRoot = scanned.pluginRootReal;
      if (pluginRoot !== undefined) {
        for (const skill of scanned.skills ?? []) {
          if (!skill.userInvocable) continue;
          commandsByKey.set(`${scanned.plugin.id}:${skill.name}`, {
            pluginId: scanned.plugin.id,
            name: skill.name,
            body: skill.body,
            pluginRoot,
            skillDir: skill.skillDir,
          });
        }
      }
      if (
        scanned.plugin.projectId === undefined &&
        scanned.externalApproved &&
        scanned.hooks !== undefined &&
        pluginRoot !== undefined
      ) {
        const pluginDataDir =
          scanned.pluginDataDir ?? pluginDataDirFor(stateDir, scanned.plugin.id);
        const expanded = expandPluginHooksEventMap(scanned.hooks, {
          pluginRoot,
          pluginDataDir,
        });
        if (
          Object.values(expanded).some((groups) =>
            groups.some((group) =>
              group.hooks.some((hook) => {
                if (hook.type === "command") {
                  return (
                    hook.command.includes(pluginDataDir) ||
                    (hook.args?.some((arg) => arg.includes(pluginDataDir)) ?? false)
                  );
                }
                if (hook.type === "http") {
                  return (
                    hook.url.includes(pluginDataDir) ||
                    Object.values(hook.headers ?? {}).some((value) => value.includes(pluginDataDir))
                  );
                }
                if (hook.type === "prompt" || hook.type === "agent") {
                  return hook.prompt.includes(pluginDataDir);
                }
                return false;
              }),
            ),
          )
        ) {
          yield* fs.makeDirectory(pluginDataDir, { recursive: true }).pipe(Effect.ignore);
        }
        for (const [event, groups] of Object.entries(expanded)) {
          const existing = hooksByEvent[event] ?? [];
          existing.push(...groups);
          hooksByEvent[event] = existing;
        }
      }
      for (const agent of scanned.agents ?? []) {
        agentsByKey.set(`${scanned.plugin.id}:${agent.name}`, {
          pluginId: scanned.plugin.id,
          name: agent.name,
          description: agent.description,
          prompt: agent.prompt,
          ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
          ...(agent.disallowedTools !== undefined
            ? { disallowedTools: agent.disallowedTools }
            : {}),
          ...(agent.model !== undefined ? { model: agent.model } : {}),
          ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
          ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
        });
      }
    }

    return {
      contextPlugins,
      commands: [...commandsByKey.values()],
      hooks: hooksByEvent,
      agents: [...agentsByKey.values()],
    };
  });

  return PluginRegistry.of({
    list: list(),
    read,
    write,
    restore,
    setEnabled,
    approveWorker,
    setWorkerFolder,
    uninstall,
    resolvePanelEntry,
    reportWorkerRuntime,
    reportMcpRuntime,
    getTurnContext,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.active),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > snapshot.seq),
              Stream.map((update) => update.active),
            ),
          );
        }),
      );
    },
    get streamWorkerDesiredState() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(workerSpecChanges);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.workerSpecs),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.workerSeq > snapshot.workerSeq),
              Stream.map((update) => update.workerSpecs),
            ),
          );
        }),
      );
    },
    get streamMcpDesiredState() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(mcpSpecChanges);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.mcpSpecs),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.mcpSeq > snapshot.mcpSeq),
              Stream.map((update) => update.mcpSpecs),
            ),
          );
        }),
      );
    },
  });
});

export const layer = Layer.effect(PluginRegistry, make);
