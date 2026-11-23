// @effect-diagnostics nodeBuiltinImport:off - plugin scanning and revisions need lstat, realpath, utimes, crypto, and path containment checks alongside readThemeFileGuarded.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type EnvironmentPlugin,
  type InstalledPlugin,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  PluginId,
  PluginManifest,
  PluginOperationError,
  type PluginSettingEntry,
  type ServerListPluginsResult,
  type ServerRestorePluginRevisionResult,
  type ServerSetPluginEnabledResult,
  type ServerUninstallPluginResult,
  THEME_CSS_MAX_LENGTH,
} from "@t3tools/contracts";
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

const PLUGINS_ARCHIVE_DIR_NAME = "plugins-archive";
const PLUGINS_HISTORY_DIR_NAME = "plugins-history";
const PLUGIN_CSS_FILE = "plugin.css";
const MAX_PLUGIN_FOLDERS = 64;
const MAX_PLUGIN_HISTORY_REVISIONS = 20;
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
const MAX_PLUGIN_CSS_BYTES = 4 * THEME_CSS_MAX_LENGTH;
const PLUGIN_REVISION_PATTERN = /^[a-f0-9]{12}$/;

const isPluginId = Schema.is(PluginId);
const isPluginRevision = (value: string): boolean => PLUGIN_REVISION_PATTERN.test(value);
const decodePluginManifestExit = Schema.decodeUnknownExit(PluginManifest);
const decodePluginManifestJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(PluginManifest),
);
const encodePluginManifestJson = Schema.encodeEffect(fromJsonStringPretty(PluginManifest));

const computePluginRevision = (manifestText: string, cssText: string): string =>
  NodeCrypto.createHash("sha256")
    .update(manifestText)
    .update("\0")
    .update(cssText)
    .digest("hex")
    .slice(0, 12);

interface PluginSnapshot {
  readonly seq: number;
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  readonly active: ReadonlyArray<EnvironmentPlugin>;
}

interface ScannedPlugin {
  readonly plugin: InstalledPlugin;
  readonly css?: string;
  readonly rawManifest?: string;
  readonly rawCss?: string;
}

export interface PluginReadResult {
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly css: string;
}

export interface PluginWriteInput {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly css: string;
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
    ) => Effect.Effect<ServerRestorePluginRevisionResult, PluginOperationError>;
    readonly setEnabled: (
      id: string,
      enabled: boolean,
    ) => Effect.Effect<ServerSetPluginEnabledResult, PluginOperationError>;
    readonly uninstall: (
      id: string,
    ) => Effect.Effect<ServerUninstallPluginResult, PluginOperationError>;
    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentPlugin>>;
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
});

const resolveSafeCssPath = (folderPath: string, cssName: string): string | null => {
  const resolvedCssPath = NodePath.resolve(folderPath, cssName);
  if (
    !cssName.startsWith("./") ||
    cssName.includes("\\") ||
    cssName.includes("\0") ||
    !isInsideDirectory(NodePath.resolve(folderPath), resolvedCssPath, false)
  ) {
    return null;
  }
  return resolvedCssPath;
};

const isExistingTargetSafe = (folderPath: string, targetCssPath: string | null): boolean => {
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
  return true;
};

// Untraced: called inside traced PluginRegistry write/restore spans.
const writeFileAtomic = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
  content: string,
  errorFor: (cause: unknown) => PluginOperationError,
) {
  const dir = NodePath.dirname(filePath);
  const base = NodePath.basename(filePath);
  const tempPath = NodePath.join(
    dir,
    `.${base}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
  );
  yield* fs.writeFileString(tempPath, content).pipe(
    Effect.andThen(fs.rename(tempPath, filePath)),
    Effect.tapError(() => fs.remove(tempPath).pipe(Effect.ignore)),
    Effect.mapError(errorFor),
  );
});

// Untraced: called inside traced PluginRegistry write/restore spans.
const saveHistoryRevision = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  stateDir: string,
  pluginId: string,
  manifestText: string,
  cssText: string,
  operation: "write" | "restore",
) {
  const revision = computePluginRevision(manifestText, cssText);
  const historyRoot = NodePath.join(stateDir, PLUGINS_HISTORY_DIR_NAME);
  const pluginHistoryDir = NodePath.join(historyRoot, pluginId);
  const revisionDir = NodePath.join(pluginHistoryDir, revision);
  const manifestPath = NodePath.join(revisionDir, PLUGIN_MANIFEST_FILE);
  const cssPath = NodePath.join(revisionDir, PLUGIN_CSS_FILE);
  const mapError = (cause: unknown) =>
    new PluginOperationError({
      pluginId,
      operation,
      reason: "write_failed",
      cause,
    });

  for (const candidate of [historyRoot, pluginHistoryDir, revisionDir, manifestPath, cssPath]) {
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
  if (existingManifest?.isFile() && existingCss?.isFile()) {
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
  storedEnabled: boolean,
): ScannedPlugin | null => {
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
  if (manifest.css === undefined) {
    return {
      plugin: {
        id: folderName,
        ...metadata,
        enabled: storedEnabled,
        contributes: [],
        revision: emptyCssRevision,
      },
      rawManifest,
    };
  }

  const cssProblem = (problem: string, css?: string) =>
    withProblem(folderName, problem, metadata, {
      revision: css === undefined ? emptyCssRevision : computePluginRevision(rawManifest, css),
      rawManifest,
      ...(css !== undefined ? { rawCss: css } : {}),
    });
  const cssName = manifest.css;
  const resolvedCssPath = resolveSafeCssPath(folderPath, cssName);
  if (resolvedCssPath === null) {
    return cssProblem('CSS path must start with "./" and stay inside the plugin folder.');
  }

  let cssStat: NodeFS.Stats;
  try {
    cssStat = NodeFS.lstatSync(resolvedCssPath);
  } catch (error) {
    return cssProblem(
      isMissingPath(error)
        ? `CSS file "${cssName}" was not found.`
        : `CSS file "${cssName}" could not be accessed.`,
    );
  }
  if (cssStat.isSymbolicLink()) return cssProblem(`CSS file "${cssName}" cannot be a symlink.`);
  if (!cssStat.isFile()) return cssProblem(`CSS file "${cssName}" is not a regular file.`);
  if (cssStat.size > MAX_PLUGIN_CSS_BYTES) {
    return cssProblem(`CSS exceeds the ${THEME_CSS_MAX_LENGTH} character limit.`);
  }
  const cssDirReal = realpathOrNull(NodePath.dirname(resolvedCssPath));
  if (cssDirReal === null || !isInsideDirectory(pluginRootReal, cssDirReal, true)) {
    return cssProblem("CSS path must stay inside the plugin folder.");
  }

  const css = readThemeFileGuarded(resolvedCssPath, MAX_PLUGIN_CSS_BYTES);
  if (css === null) return cssProblem(`CSS file "${cssName}" could not be read.`);
  if (css.length > THEME_CSS_MAX_LENGTH) {
    return cssProblem(`CSS exceeds the ${THEME_CSS_MAX_LENGTH} character limit.`, css);
  }
  if (themeCssLoadsRemoteFiles(css)) {
    return cssProblem(
      "CSS cannot load remote files (@import, image-set(), or non-local url()).",
      css,
    );
  }

  return {
    plugin: {
      id: folderName,
      ...metadata,
      enabled: storedEnabled,
      contributes: ["css"],
      revision: computePluginRevision(rawManifest, css),
    },
    css,
    rawManifest,
    rawCss: css,
  };
};

const scanPlugins = Effect.fnUntraced(function* (
  pluginsDir: string,
  pluginSettings: Readonly<Record<string, PluginSettingEntry>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(pluginsDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const plugins: Array<InstalledPlugin> = [];
  const active: Array<EnvironmentPlugin> = [];
  let examined = 0;

  for (const folderName of entries.toSorted()) {
    const storedEnabled =
      Object.hasOwn(pluginSettings, folderName) && pluginSettings[folderName]?.enabled === true;
    const scanned = inspectPluginFolder(pluginsDir, folderName, storedEnabled);
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
    if (
      scanned.plugin.enabled &&
      scanned.plugin.problem === undefined &&
      scanned.css !== undefined &&
      isPluginId(scanned.plugin.id)
    ) {
      active.push({ id: scanned.plugin.id, css: scanned.css });
    }
  }

  return { plugins, active };
});

const make = Effect.gen(function* () {
  const { pluginsDir, stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;

  const changes = yield* PubSub.sliding<PluginSnapshot>(1);
  const published = yield* Ref.make<PluginSnapshot>({ seq: 0, plugins: [], active: [] });
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
      const { plugins, active } = yield* scanPlugins(pluginsDir, pluginSettings).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const [activeChanged, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, PluginSnapshot], PluginSnapshot] => {
          const sameActive = Equal.equals(previous.active, active);
          const samePlugins = Equal.equals(previous.plugins, plugins);
          if (sameActive && samePlugins) return [[false, previous], previous];
          const updated: PluginSnapshot = {
            seq: sameActive ? previous.seq : previous.seq + 1,
            plugins,
            active,
          };
          return [[!sameActive, updated], updated];
        },
      );
      if (activeChanged) {
        yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
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
        const scanned = inspectPluginFolder(pluginsDir, id, false);
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
          css: scanned.css ?? "",
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
          if (input.css.length > THEME_CSS_MAX_LENGTH || themeCssLoadsRemoteFiles(input.css)) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_css",
            });
          }
          const manifestDecoded = decodePluginManifestExit({
            name: input.id,
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.version !== undefined ? { version: input.version } : {}),
            css: `./${PLUGIN_CSS_FILE}`,
          });
          if (manifestDecoded._tag === "Failure") {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "has_problem",
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
          const cssPath = NodePath.join(folderPath, PLUGIN_CSS_FILE);
          if (!isExistingTargetSafe(folderPath, cssPath)) {
            return yield* new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "has_problem",
            });
          }

          const created = folderStat === null;
          let before: string | undefined;
          if (!created) {
            const existing = inspectPluginFolder(pluginsDir, input.id, false);
            if (existing?.rawManifest !== undefined) {
              before = yield* saveHistoryRevision(
                fs,
                stateDir,
                input.id,
                existing.rawManifest,
                existing.rawCss ?? "",
                "write",
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
          yield* writeFileAtomic(fs, cssPath, input.css, mapWriteError);

          const after = yield* saveHistoryRevision(
            fs,
            stateDir,
            input.id,
            manifestText,
            input.css,
            "write",
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
    function* (id, revision, enable) {
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
          if (decoded._tag === "Failure" || decoded.value.name !== id) {
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
              : resolveSafeCssPath(folderPath, decoded.value.css);
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

          const manifestDir = NodePath.join(folderPath, PLUGIN_MANIFEST_DIR);
          const manifestPath = NodePath.join(manifestDir, PLUGIN_MANIFEST_FILE);
          if (!isExistingTargetSafe(folderPath, targetCssPath)) {
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "restore",
              reason: "has_problem",
            });
          }
          if (lstatOrNull(folderPath) !== null) {
            const existing = inspectPluginFolder(pluginsDir, id, false);
            if (existing?.rawManifest !== undefined) {
              yield* saveHistoryRevision(
                fs,
                stateDir,
                id,
                existing.rawManifest,
                existing.rawCss ?? "",
                "restore",
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

          if (enable === true) {
            yield* settings.updateSettings({ plugins: { [id]: { enabled: true } } }).pipe(
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
  )(function* (id, enabled) {
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
        yield* settings.updateSettings({ plugins: { [id]: { enabled } } }).pipe(
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

          yield* refresh;
          return { id, archivedTo };
        }),
      );
    },
  );

  return PluginRegistry.of({
    list: list(),
    read,
    write,
    restore,
    setEnabled,
    uninstall,
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
  });
});

export const layer = Layer.effect(PluginRegistry, make);
