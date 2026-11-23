// @effect-diagnostics nodeBuiltinImport:off - plugin scanning needs lstat, realpath, and path containment checks alongside readThemeFileGuarded.
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
  type ServerSetPluginEnabledResult,
  type ServerUninstallPluginResult,
  THEME_CSS_MAX_LENGTH,
} from "@t3tools/contracts";
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
const MAX_PLUGIN_FOLDERS = 64;
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
const MAX_PLUGIN_CSS_BYTES = 4 * THEME_CSS_MAX_LENGTH;

const isPluginId = Schema.is(PluginId);
const decodePluginManifestExit = Schema.decodeUnknownExit(PluginManifest);

interface PluginSnapshot {
  readonly seq: number;
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  readonly active: ReadonlyArray<EnvironmentPlugin>;
}

interface ScannedPlugin {
  readonly plugin: InstalledPlugin;
  readonly css?: string;
}

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ServerListPluginsResult, PluginOperationError>;
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
): ScannedPlugin => ({
  plugin: { id, ...metadata, enabled: false, contributes: [], problem },
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
  if (manifest.name !== folderName) {
    return withProblem(
      folderName,
      `Manifest name "${manifest.name}" does not match folder name "${folderName}".`,
    );
  }

  const metadata: PluginMetadata = {
    ...(manifest.displayName !== undefined ? { displayName: manifest.displayName } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
  };
  if (manifest.css === undefined) {
    return { plugin: { id: folderName, ...metadata, enabled: storedEnabled, contributes: [] } };
  }

  const cssProblem = (problem: string) => withProblem(folderName, problem, metadata);
  const cssName = manifest.css;
  const resolvedCssPath = NodePath.resolve(folderPath, cssName);
  if (
    !cssName.startsWith("./") ||
    cssName.includes("\\") ||
    cssName.includes("\0") ||
    !isInsideDirectory(NodePath.resolve(folderPath), resolvedCssPath, false)
  ) {
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
    return cssProblem(`CSS exceeds the ${THEME_CSS_MAX_LENGTH} character limit.`);
  }
  if (themeCssLoadsRemoteFiles(css)) {
    return cssProblem("CSS cannot load remote files (@import, image-set(), or non-local url()).");
  }

  return {
    plugin: { id: folderName, ...metadata, enabled: storedEnabled, contributes: ["css"] },
    css,
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
