// @effect-diagnostics nodeBuiltinImport:off - plugin scanning and revisions need lstat, realpath, utimes, crypto, and path containment checks alongside readThemeFileGuarded.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type EnvironmentPlugin,
  type InstalledPlugin,
  type InstalledPluginPanel,
  type InstalledPluginWorker,
  type IsoDateTime,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MAX_PANELS,
  PLUGIN_PANEL_HTML_MAX_CHARS,
  PLUGIN_WORKER_CODE_MAX_CHARS,
  PLUGIN_WORKER_MAX_FOLDERS,
  type PluginContribution,
  PluginId,
  PluginManifest,
  type PluginManifestWorkerFolder,
  PluginOperationError,
  type PluginSettingEntry,
  type PluginWorkerEveryMinutes,
  type PluginWorkerFolderAccess,
  type PluginWorkerStatus,
  type ServerApprovePluginWorkerResult,
  type ServerListPluginsResult,
  type ServerRestorePluginRevisionResult,
  type ServerSetPluginEnabledResult,
  type ServerSetPluginWorkerFolderResult,
  type ServerUninstallPluginResult,
  THEME_CSS_MAX_LENGTH,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { readThemeFileGuarded } from "../environmentTheme.ts";
import * as ServerSettings from "../serverSettings.ts";
import { watchDirectoryPath } from "../watchDirectoryReplacements.ts";
import { writeFileAtomic } from "./atomicFile.ts";
import {
  computePluginWorkerPowersHash,
  detectPluginWorkerRuntimeCapabilities,
  validateAndCanonicalizeWorkerFolderPath,
} from "./pluginWorkerUtils.ts";

const PLUGINS_ARCHIVE_DIR_NAME = "plugins-archive";
const PLUGINS_HISTORY_DIR_NAME = "plugins-history";
const PLUGIN_CSS_FILE = "plugin.css";
const PLUGIN_WORKER_FILE = "worker.mjs";
const MAX_PLUGIN_FOLDERS = 64;
const MAX_PLUGIN_HISTORY_REVISIONS = 20;
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
const MAX_PLUGIN_CSS_BYTES = 4 * THEME_CSS_MAX_LENGTH;
const MAX_PLUGIN_WORKER_BYTES = 4 * PLUGIN_WORKER_CODE_MAX_CHARS;
const PLUGIN_REVISION_PATTERN = /^[a-f0-9]{12}$/;
const PANEL_ROOT_ENTRY_PATTERN = /^\.\/(?!\.)[^/\\\0]+\.html$/;
const WORKER_ROOT_ENTRY_PATTERN = /^\.\/(?!\.)[^/\\\0]+\.mjs$/;

const isPluginId = Schema.is(PluginId);
const isPluginRevision = (value: string): boolean => PLUGIN_REVISION_PATTERN.test(value);
const decodePluginManifestExit = Schema.decodeUnknownExit(PluginManifest);
const decodePluginManifestJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(PluginManifest),
);
const encodePluginManifestJson = Schema.encodeEffect(fromJsonStringPretty(PluginManifest));

const computePluginRevision = (
  manifestText: string,
  cssText: string,
  panelHtmls: ReadonlyArray<string> = [],
  workerCode?: string,
): string => {
  const hash = NodeCrypto.createHash("sha256").update(manifestText).update("\0").update(cssText);
  for (const html of panelHtmls) {
    hash.update("\0").update(html);
  }
  if (workerCode !== undefined) {
    hash.update("\0").update(workerCode);
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

interface PluginSnapshot {
  readonly seq: number;
  readonly workerSeq: number;
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  readonly active: ReadonlyArray<EnvironmentPlugin>;
  readonly panelEntries: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly workerSpecs: ReadonlyArray<PluginWorkerDesiredSpec>;
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
  readonly css?: string;
  readonly cssPath?: string;
  readonly panels?: ReadonlyArray<ScannedPanel>;
  readonly worker?: ScannedWorker;
  readonly rawManifest?: string;
  readonly rawCss?: string;
  readonly rawPanels?: ReadonlyArray<{ readonly fileName: string; readonly html: string }>;
  readonly rawWorker?: { readonly fileName: string; readonly code: string };
}

export interface PluginPanelContent {
  readonly id: PluginId;
  readonly title: string;
  readonly html: string;
}

export interface PluginReadResult {
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly css?: string;
  readonly panels?: ReadonlyArray<PluginPanelContent>;
  readonly worker?: PluginWorkerContent;
}

export interface PluginWriteInput {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly css?: string;
  readonly panels?: ReadonlyArray<PluginPanelContent>;
  readonly worker?: PluginWorkerContent;
}

export interface PluginWriteResult {
  readonly plugin: InstalledPlugin;
  readonly created: boolean;
  readonly before?: string;
  readonly after: string;
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
      options?: { readonly approveWorker?: boolean },
    ) => Effect.Effect<ServerRestorePluginRevisionResult, PluginOperationError>;
    readonly setEnabled: (
      id: string,
      enabled: boolean,
      options?: { readonly approveWorker?: boolean },
    ) => Effect.Effect<ServerSetPluginEnabledResult, PluginOperationError>;
    readonly approveWorker: (
      id: string,
    ) => Effect.Effect<ServerApprovePluginWorkerResult, PluginOperationError>;
    readonly setWorkerFolder: (
      id: string,
      folderId: PluginId,
      path: string | null,
    ) => Effect.Effect<ServerSetPluginWorkerFolderResult, PluginOperationError>;
    readonly uninstall: (
      id: string,
    ) => Effect.Effect<ServerUninstallPluginResult, PluginOperationError>;
    readonly resolvePanelEntry: (
      pluginId: string,
      panelId: string,
    ) => Effect.Effect<string, PluginOperationError>;
    readonly reportWorkerRuntime: (
      pluginId: string,
      state: PluginWorkerRuntimeState | null,
    ) => Effect.Effect<void>;
    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentPlugin>>;
    readonly streamWorkerDesiredState: Stream.Stream<ReadonlyArray<PluginWorkerDesiredSpec>>;
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
    readonly rawManifest?: string;
    readonly rawCss?: string;
    readonly cssPath?: string;
    readonly rawPanels?: ReadonlyArray<{ readonly fileName: string; readonly html: string }>;
    readonly rawWorker?: { readonly fileName: string; readonly code: string };
    readonly workerPath?: string;
  } = {},
): ScannedPlugin => ({
  plugin: {
    id,
    ...metadata,
    enabled: false,
    contributes: [],
    ...(extra.revision !== undefined ? { revision: extra.revision } : {}),
    problem,
  },
  ...(extra.rawManifest !== undefined ? { rawManifest: extra.rawManifest } : {}),
  ...(extra.rawCss !== undefined ? { rawCss: extra.rawCss } : {}),
  ...(extra.cssPath !== undefined ? { cssPath: extra.cssPath } : {}),
  ...(extra.rawPanels !== undefined ? { rawPanels: extra.rawPanels } : {}),
  ...(extra.rawWorker !== undefined ? { rawWorker: extra.rawWorker } : {}),
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

const isExistingTargetSafe = (
  folderPath: string,
  targetCssPath: string | null,
  targetPanelPaths: ReadonlyArray<string>,
  targetWorkerPath: string | null = null,
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
  return true;
};

// Untraced: called inside traced PluginRegistry write/restore spans.
// Removes only files the previous manifest named; their copies are in the `before` revision.
const cleanupStalePluginFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  folderPath: string,
  previousPanelFileNames: ReadonlyArray<string>,
  keepPanelFileNames: ReadonlySet<string>,
  previousCssPath: string | null,
  nextCssPath: string | null,
  previousWorkerPath: string | null = null,
  nextWorkerPath: string | null = null,
) {
  const stale = previousPanelFileNames
    .filter((fileName) => !keepPanelFileNames.has(fileName))
    .map((fileName) => NodePath.join(folderPath, fileName));
  if (previousCssPath !== null && previousCssPath !== nextCssPath) stale.push(previousCssPath);
  if (previousWorkerPath !== null && previousWorkerPath !== nextWorkerPath) {
    stale.push(previousWorkerPath);
  }
  for (const candidate of stale) {
    const stat = lstatOrNull(candidate);
    if (stat !== null && !stat.isSymbolicLink() && stat.isFile()) {
      yield* fs.remove(candidate, { force: true }).pipe(Effect.ignoreCause({ log: true }));
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
) {
  const revision = computePluginRevision(
    manifestText,
    cssText,
    panels.map((panel) => panel.html),
    worker?.code,
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
    (workerTarget === null || lstatOrNull(workerTarget.path)?.isFile() === true)
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

const inspectPluginFolder = (
  pluginsDir: string,
  folderName: string,
  storedSetting: PluginSettingEntry | undefined,
  homeDirectory: string,
  runtimeState: PluginWorkerRuntimeState | undefined,
  defaultNetworkRestricted: boolean,
): ScannedPlugin | null => {
  const storedEnabled = storedSetting?.enabled === true;
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

  const manifestDir = NodePath.join(folderPath, PLUGIN_MANIFEST_DIR);
  // A missing manifest directory is reported by the manifest check below.
  if (lstatOrNull(manifestDir)?.isSymbolicLink() === true) {
    return withProblem(folderName, "Manifest directory .t3-plugin cannot be a symlink.");
  }
  const manifestPath = NodePath.join(manifestDir, PLUGIN_MANIFEST_FILE);
  let manifestStat: NodeFS.Stats;
  try {
    manifestStat = NodeFS.lstatSync(manifestPath);
  } catch (error) {
    return withProblem(
      folderName,
      isMissingPath(error)
        ? "Missing .t3-plugin/plugin.json manifest."
        : "Manifest .t3-plugin/plugin.json could not be accessed.",
    );
  }
  if (manifestStat.isSymbolicLink()) {
    return withProblem(folderName, "Manifest .t3-plugin/plugin.json cannot be a symlink.");
  }
  if (!manifestStat.isFile()) {
    return withProblem(folderName, "Manifest .t3-plugin/plugin.json is not a regular file.");
  }
  const manifestDirReal = realpathOrNull(manifestDir);
  if (manifestDirReal === null || !isInsideDirectory(pluginRootReal, manifestDirReal, false)) {
    return withProblem(
      folderName,
      "Manifest directory .t3-plugin must stay inside the plugin folder.",
    );
  }

  const rawManifest = readThemeFileGuarded(manifestPath, MAX_PLUGIN_MANIFEST_BYTES);
  if (rawManifest === null) {
    return withProblem(
      folderName,
      "Manifest .t3-plugin/plugin.json could not be read or is too large.",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawManifest);
  } catch {
    return withProblem(folderName, "Manifest .t3-plugin/plugin.json is not valid JSON.");
  }

  const decoded = decodePluginManifestExit(parsedJson);
  if (decoded._tag === "Failure") {
    const rawName = Predicate.hasProperty(parsedJson, "name") ? parsedJson.name : undefined;
    return withProblem(
      folderName,
      typeof rawName === "string" && !isPluginId(rawName)
        ? `Manifest name "${rawName}" is not a valid plugin id.`
        : "Manifest .t3-plugin/plugin.json has invalid or missing fields.",
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
  if (
    manifest.css === undefined &&
    manifest.panels === undefined &&
    manifest.worker === undefined
  ) {
    return withProblem(
      folderName,
      "Plugin manifest must define css, at least one panel, or a worker.",
      metadata,
      { revision: emptyCssRevision, rawManifest },
    );
  }

  let css: string | undefined;
  let cssPath: string | undefined;
  if (manifest.css !== undefined) {
    const cssRead = readPluginFileGuarded(folderPath, pluginRootReal, manifest.css, {
      kind: "CSS",
      maxBytes: MAX_PLUGIN_CSS_BYTES,
      allowSubfolders: true,
      oversizeProblem: `CSS exceeds the ${THEME_CSS_MAX_LENGTH} character limit.`,
    });
    if (!cssRead.ok) {
      return withProblem(folderName, cssRead.problem, metadata, {
        revision: emptyCssRevision,
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
          rawManifest,
          rawCss: css,
          cssPath,
        },
      );
    }
  }

  const panels: Array<ScannedPanel> = [];
  if (manifest.panels !== undefined) {
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
  if (manifest.worker !== undefined) {
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

  const contributes: Array<PluginContribution> = [];
  if (css !== undefined) contributes.push("css");
  if (panels.length > 0) contributes.push("panel");
  if (scannedWorker !== undefined) contributes.push("worker");
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
      revision: computePluginRevision(
        rawManifest,
        css ?? "",
        panels.map((panel) => panel.html),
        scannedWorker?.code,
      ),
      ...(runtimeProblem !== undefined ? { problem: runtimeProblem } : {}),
    },
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
    rawManifest,
  };
};

const scanPlugins = Effect.fnUntraced(function* (
  pluginsDir: string,
  pluginSettings: Readonly<Record<string, PluginSettingEntry>>,
  homeDirectory: string,
  runtimeStates: ReadonlyMap<string, PluginWorkerRuntimeState>,
  defaultNetworkRestricted: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(pluginsDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const plugins: Array<InstalledPlugin> = [];
  const active: Array<EnvironmentPlugin> = [];
  const panelEntries = new Map<string, ReadonlyMap<string, string>>();
  const workerSpecs: Array<PluginWorkerDesiredSpec> = [];
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
    if (
      scanned.plugin.enabled &&
      scanned.plugin.problem === undefined &&
      isPluginId(scanned.plugin.id)
    ) {
      const activePanels =
        scanned.panels !== undefined && scanned.panels.length > 0
          ? scanned.panels.map(({ id, title }) => ({ id, title }))
          : undefined;
      if (
        scanned.css !== undefined ||
        activePanels !== undefined ||
        scanned.plugin.worker !== undefined
      ) {
        active.push({
          id: scanned.plugin.id,
          css: scanned.css ?? "",
          ...(activePanels !== undefined ? { panels: activePanels } : {}),
          ...(scanned.plugin.worker !== undefined ? { worker: scanned.plugin.worker } : {}),
        });
      }
      if (scanned.panels !== undefined && scanned.panels.length > 0) {
        panelEntries.set(
          scanned.plugin.id,
          new Map(scanned.panels.map((panel) => [panel.id, panel.canonicalPath])),
        );
      }
    }
  }

  return { plugins, active, panelEntries, workerSpecs };
});

const make = Effect.gen(function* () {
  const { pluginsDir, stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const defaultNetworkRestricted = detectPluginWorkerRuntimeCapabilities().networkRestricted;

  const changes = yield* PubSub.sliding<PluginSnapshot>(1);
  const workerSpecChanges = yield* PubSub.unbounded<PluginSnapshot>();
  const runtimeStates = new Map<string, PluginWorkerRuntimeState>();
  const published = yield* Ref.make<PluginSnapshot>({
    seq: 0,
    workerSeq: 0,
    plugins: [],
    active: [],
    panelEntries: new Map(),
    workerSpecs: [],
  });
  const refreshSemaphore = yield* Semaphore.make(1);
  const mutationSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const pluginSettings = yield* settings.getSettings.pipe(
        Effect.map((current) => current.plugins),
        Effect.orElseSucceed((): Readonly<Record<string, PluginSettingEntry>> => ({})),
      );
      const { plugins, active, panelEntries, workerSpecs } = yield* scanPlugins(
        pluginsDir,
        pluginSettings,
        homeDirectory,
        runtimeStates,
        defaultNetworkRestricted,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const [activeChanged, workerSpecsChanged, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, boolean, PluginSnapshot], PluginSnapshot] => {
          const sameActive = Equal.equals(previous.active, active);
          const samePlugins = Equal.equals(previous.plugins, plugins);
          const sameWorkerSpecs = Equal.equals(previous.workerSpecs, workerSpecs);
          const updated: PluginSnapshot = {
            seq: sameActive ? previous.seq : previous.seq + 1,
            workerSeq: sameWorkerSpecs ? previous.workerSeq : previous.workerSeq + 1,
            plugins,
            active,
            panelEntries,
            workerSpecs,
          };
          if (sameActive && samePlugins && sameWorkerSpecs) {
            return [[false, false, updated], updated];
          }
          return [[!sameActive, !sameWorkerSpecs, updated], updated];
        },
      );
      if (activeChanged) {
        yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      }
      if (workerSpecsChanged) {
        yield* PubSub.publish(workerSpecChanges, next).pipe(Effect.asVoid);
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
    Stream.map((current) => current.plugins),
    Stream.changesWith(Equal.equals),
  );
  yield* Stream.runForEach(pluginSettingChanges, () =>
    refresh.pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);

  const list = Effect.fn("PluginRegistry.list")(function* () {
    const snapshot = yield* refresh;
    return { pluginsDir, plugins: snapshot.plugins };
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
          const hasCss = input.css !== undefined;
          const hasPanels = input.panels !== undefined && input.panels.length > 0;
          const hasWorker = input.worker !== undefined;
          if (!hasCss && !hasPanels && !hasWorker) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_panel",
            });
          }
          if (
            input.css !== undefined &&
            (input.css.length > THEME_CSS_MAX_LENGTH || themeCssLoadsRemoteFiles(input.css))
          ) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_css",
            });
          }
          if (input.panels !== undefined) {
            if (input.panels.length === 0 || input.panels.length > PLUGIN_MAX_PANELS) {
              return yield* new PluginOperationError({
                pluginId: input.id,
                operation: "write",
                reason: "invalid_panel",
              });
            }
            for (const panel of input.panels) {
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
          if (input.worker !== undefined) {
            if (
              input.worker.code.length > PLUGIN_WORKER_CODE_MAX_CHARS ||
              Buffer.byteLength(input.worker.code, "utf8") > MAX_PLUGIN_WORKER_BYTES ||
              (input.worker.folders !== undefined &&
                input.worker.folders.length > PLUGIN_WORKER_MAX_FOLDERS)
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
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.version !== undefined ? { version: input.version } : {}),
            ...(input.css !== undefined ? { css: `./${PLUGIN_CSS_FILE}` } : {}),
            ...(input.panels !== undefined
              ? {
                  panels: input.panels.map((panel) => ({
                    id: panel.id,
                    title: panel.title,
                    entry: `./${panel.id}.html`,
                  })),
                }
              : {}),
            ...(input.worker !== undefined
              ? {
                  worker: {
                    entry: `./${PLUGIN_WORKER_FILE}`,
                    ...(input.worker.everyMinutes !== undefined
                      ? { everyMinutes: input.worker.everyMinutes }
                      : {}),
                    ...(input.worker.folders !== undefined
                      ? { folders: input.worker.folders }
                      : {}),
                    ...(input.worker.network !== undefined
                      ? { network: input.worker.network }
                      : {}),
                  },
                }
              : {}),
          });
          if (manifestDecoded._tag === "Failure") {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason:
                input.worker !== undefined
                  ? "invalid_worker"
                  : input.panels !== undefined
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
          const manifestDir = NodePath.join(folderPath, PLUGIN_MANIFEST_DIR);
          const manifestPath = NodePath.join(manifestDir, PLUGIN_MANIFEST_FILE);
          const cssPath =
            input.css !== undefined ? NodePath.join(folderPath, PLUGIN_CSS_FILE) : null;
          const panelWrites = (input.panels ?? []).map((panel) => ({
            fileName: `${panel.id}.html`,
            targetPath: NodePath.join(folderPath, `${panel.id}.html`),
            html: panel.html,
          }));
          const workerPath =
            input.worker !== undefined ? NodePath.join(folderPath, PLUGIN_WORKER_FILE) : null;
          if (
            !isExistingTargetSafe(
              folderPath,
              cssPath,
              panelWrites.map((panel) => panel.targetPath),
              workerPath,
            )
          ) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "has_problem",
            });
          }

          const created = folderStat === null;
          let before: string | undefined;
          let previousCssPath: string | null = null;
          let previousPanelFileNames: ReadonlyArray<string> = [];
          let previousWorkerPath: string | null = null;
          if (!created) {
            const existing = inspectPluginFolder(
              pluginsDir,
              input.id,
              undefined,
              homeDirectory,
              undefined,
              defaultNetworkRestricted,
            );
            previousCssPath = existing?.cssPath ?? null;
            previousPanelFileNames = (existing?.rawPanels ?? []).map((panel) => panel.fileName);
            previousWorkerPath = existing?.worker?.path ?? null;
            if (existing?.rawManifest !== undefined) {
              before = yield* saveHistoryRevision(
                fs,
                stateDir,
                input.id,
                existing.rawManifest,
                existing.rawCss ?? "",
                existing.rawPanels ?? [],
                "write",
                existing.rawWorker,
              );
            }
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
          if (cssPath !== null && input.css !== undefined) {
            yield* writeFileAtomic(fs, cssPath, input.css, mapWriteError);
          }
          for (const panel of panelWrites) {
            yield* writeFileAtomic(fs, panel.targetPath, panel.html, mapWriteError);
          }
          if (workerPath !== null && input.worker !== undefined) {
            yield* writeFileAtomic(fs, workerPath, input.worker.code, mapWriteError);
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
          );

          const after = yield* saveHistoryRevision(
            fs,
            stateDir,
            input.id,
            manifestText,
            input.css ?? "",
            panelWrites.map(({ fileName, html }) => ({ fileName, html })),
            "write",
            input.worker === undefined
              ? undefined
              : { fileName: PLUGIN_WORKER_FILE, code: input.worker.code },
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
          if (
            decoded._tag === "Failure" ||
            decoded.value.name !== id ||
            (decoded.value.css === undefined &&
              decoded.value.panels === undefined &&
              decoded.value.worker === undefined)
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
          yield* cleanupStalePluginFiles(
            fs,
            folderPath,
            previousPanelFileNames,
            new Set(panelRestores.map((panel) => panel.fileName)),
            previousCssPath,
            targetCssPath,
            previousWorkerPath,
            workerRestore?.targetPath ?? null,
          );

          if (enable === true) {
            yield* settings
              .updateSettings({
                plugins: {
                  [id]: {
                    enabled: true,
                    ...(options?.approveWorker === true && workerRestore !== undefined
                      ? { workerApproval: workerRestore.powersHash }
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
        const targetSpec = current.workerSpecs.find((spec) => spec.pluginId === id);
        yield* settings
          .updateSettings({
            plugins: {
              [id]: {
                enabled,
                ...(enabled && options?.approveWorker === true && targetSpec !== undefined
                  ? { workerApproval: targetSpec.powersHash }
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
  )(function* (id) {
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
    function* (id) {
      return yield* mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
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
  });
});

export const layer = Layer.effect(PluginRegistry, make);
