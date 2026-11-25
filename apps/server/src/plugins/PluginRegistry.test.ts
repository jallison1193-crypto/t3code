import {
  CLAUDE_PLUGIN_MANIFEST_DIR,
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  PLUGIN_INSTRUCTIONS_MAX_BYTES,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MAX_SKILLS,
  PLUGIN_SKILL_MAX_BYTES,
  PluginId,
  ProjectId,
  THEME_CSS_MAX_LENGTH,
  type EnvironmentPlugin,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

interface PluginFixture {
  readonly manifest?: string | null;
  readonly claudeManifest?: string | null;
  readonly files?: Readonly<Record<string, string>>;
}

interface RepoProjectFixture {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly plugins: Readonly<Record<string, PluginFixture>>;
}

const makeTestProjectRow = (
  projectId: ProjectId,
  title: string,
  workspaceRoot: string,
): ProjectStore.ProjectRow => ({
  projectId,
  title,
  hasCustomTitle: false,
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  trackedFolders: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
});

const withPluginRegistry = <A, E>(
  fixtures: Readonly<Record<string, PluginFixture>>,
  body: Effect.Effect<
    A,
    E,
    | PluginRegistry.PluginRegistry
    | ServerSettingsService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
  initialSettings: ServerSettings = DEFAULT_SERVER_SETTINGS,
  repoProjects: ReadonlyArray<RepoProjectFixture> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-registry-" });
    const pluginsDir = path.join(baseDir, "userdata", "plugins");
    yield* fs.makeDirectory(pluginsDir, { recursive: true });

    const populatePluginFolder = (rootDir: string, folderName: string, fixture: PluginFixture) =>
      Effect.gen(function* () {
        const pluginRoot = path.join(rootDir, folderName);
        yield* fs.makeDirectory(pluginRoot, { recursive: true });
        if (fixture.manifest !== undefined && fixture.manifest !== null) {
          const manifestDir = path.join(pluginRoot, PLUGIN_MANIFEST_DIR);
          yield* fs.makeDirectory(manifestDir, { recursive: true });
          yield* fs.writeFileString(path.join(manifestDir, PLUGIN_MANIFEST_FILE), fixture.manifest);
        }
        if (fixture.claudeManifest !== undefined && fixture.claudeManifest !== null) {
          const claudeDir = path.join(pluginRoot, CLAUDE_PLUGIN_MANIFEST_DIR);
          yield* fs.makeDirectory(claudeDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(claudeDir, PLUGIN_MANIFEST_FILE),
            fixture.claudeManifest,
          );
        }
        for (const [relativePath, content] of Object.entries(fixture.files ?? {})) {
          const filePath = path.join(pluginRoot, relativePath);
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, content);
        }
      });

    for (const [folderName, fixture] of Object.entries(fixtures)) {
      yield* populatePluginFolder(pluginsDir, folderName, fixture);
    }

    const projectRows: Array<ProjectStore.ProjectRow> = [];
    for (const repoProject of repoProjects) {
      const workspaceRoot = path.join(baseDir, "projects", repoProject.projectId);
      const repoPluginsDir = path.join(workspaceRoot, ".t3", "plugins");
      yield* fs.makeDirectory(repoPluginsDir, { recursive: true });
      for (const [folderName, fixture] of Object.entries(repoProject.plugins)) {
        yield* populatePluginFolder(repoPluginsDir, folderName, fixture);
      }
      projectRows.push(makeTestProjectRow(repoProject.projectId, repoProject.title, workspaceRoot));
    }

    const settingsRef = yield* Ref.make(initialSettings);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const settingsSubscribed = yield* Deferred.make<void>();
    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)).pipe(
          Effect.tap((next) => PubSub.publish(settingsChanges, next)),
        ),
      streamChanges: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(settingsChanges);
          yield* Deferred.succeed(settingsSubscribed, undefined);
          return Stream.fromSubscription(subscription);
        }),
      ),
    });
    const projectStoreLayer = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.succeed(
          Option.fromUndefinedOr(projectRows.find((row) => row.projectId === projectId)),
        ),
      list: (options) =>
        Effect.succeed(
          options?.projectIds === undefined
            ? projectRows
            : projectRows.filter((row) => options.projectIds!.includes(row.projectId)),
        ),
    });

    const basePluginLayer =
      projectRows.length > 0
        ? PluginRegistry.layer.pipe(Layer.provide(projectStoreLayer))
        : PluginRegistry.layer;
    return yield* Deferred.await(settingsSubscribed).pipe(
      Effect.andThen(body),
      Effect.provide(
        basePluginLayer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(settingsLayer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

describe("PluginRegistry", () => {
  it.effect(
    "lists a valid plugin disabled by default with contributes and ignores unknown fields",
    () =>
      withPluginRegistry(
        {
          "compact-sidebar": {
            manifest: JSON.stringify({
              name: "compact-sidebar",
              displayName: "Compact Sidebar",
              description: "Tightens sidebar rows.",
              version: "1.2.3",
              css: "./plugin.css",
              author: "someone",
              extraNested: { ignored: true },
            }),
            files: {
              "plugin.css": "[data-thread-item] { padding-block: 2px; }",
            },
          },
        },
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const config = yield* ServerConfig.ServerConfig;

          const listed = yield* registry.list;
          assert.strictEqual(listed.pluginsDir, config.pluginsDir);
          assert.strictEqual(listed.plugins.length, 1);
          assert.match(listed.plugins[0]?.revision ?? "", /^[a-f0-9]{12}$/);
          assert.deepEqual(listed.plugins, [
            {
              id: "compact-sidebar",
              displayName: "Compact Sidebar",
              description: "Tightens sidebar rows.",
              version: "1.2.3",
              enabled: false,
              contributes: ["css"],
              revision: listed.plugins[0]!.revision,
            },
          ]);

          const snapshots = yield* registry.streamChanges.pipe(Stream.take(1), Stream.runCollect);
          assert.deepEqual(Array.from(snapshots), [[]]);
        }),
      ),
  );

  it.effect("lists malformed plugins with a problem and emits no CSS for them", () => {
    const oversizedCss = `/* ${"a".repeat(THEME_CSS_MAX_LENGTH)} */`;
    return withPluginRegistry(
      {
        "missing-manifest": {},
        "name-mismatch": {
          manifest: JSON.stringify({ name: "other-name", css: "./plugin.css" }),
          files: { "plugin.css": ":root { --a: 1; }" },
        },
        "escaping-css": {
          manifest: JSON.stringify({ name: "escaping-css", css: "../outside.css" }),
        },
        "dot-escaping-css": {
          manifest: JSON.stringify({ name: "dot-escaping-css", css: "./../outside.css" }),
        },
        "remote-css": {
          manifest: JSON.stringify({ name: "remote-css", css: "./plugin.css" }),
          files: { "plugin.css": "@import url(https://example.com/x.css);" },
        },
        "oversized-css": {
          manifest: JSON.stringify({ name: "oversized-css", css: "./plugin.css" }),
          files: { "plugin.css": oversizedCss },
        },
      },
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const { plugins } = yield* registry.list;
        const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

        assert.strictEqual(plugins.length, 6);
        for (const id of [
          "missing-manifest",
          "name-mismatch",
          "escaping-css",
          "dot-escaping-css",
          "remote-css",
          "oversized-css",
        ]) {
          const plugin = byId.get(id);
          assert.isDefined(plugin, id);
          assert.isDefined(plugin?.problem, `${id} should report a problem`);
          assert.strictEqual(plugin?.enabled, false, `${id} must stay disabled`);
          assert.deepEqual(plugin?.contributes, [], `${id} must not contribute css`);
        }

        assert.match(byId.get("missing-manifest")?.problem ?? "", /missing/i);
        assert.match(byId.get("name-mismatch")?.problem ?? "", /does not match folder name/i);
        assert.match(byId.get("escaping-css")?.problem ?? "", /start with "\.\/"/i);
        assert.match(byId.get("dot-escaping-css")?.problem ?? "", /stay inside/i);
        assert.match(byId.get("remote-css")?.problem ?? "", /remote files/i);
        assert.match(byId.get("oversized-css")?.problem ?? "", /limit/i);

        const enableFailed = yield* registry.setEnabled("remote-css", true).pipe(Effect.flip);
        assert.strictEqual(enableFailed._tag, "PluginOperationError");
        assert.strictEqual(enableFailed.reason, "has_problem");

        const snapshots = yield* registry.streamChanges.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(Array.from(snapshots), [[]]);
      }),
      {
        ...DEFAULT_SERVER_SETTINGS,
        plugins: {
          "remote-css": { enabled: true },
          "oversized-css": { enabled: true },
        },
      },
    );
  });

  it.effect.skipIf(!symlinksSupported)("rejects a symlinked CSS file with a problem", () =>
    withPluginRegistry(
      {
        "linked-css": {
          manifest: JSON.stringify({ name: "linked-css", css: "./plugin.css" }),
        },
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { pluginsDir } = yield* ServerConfig.ServerConfig;
        const registry = yield* PluginRegistry.PluginRegistry;

        const outside = path.join(pluginsDir, "..", "outside.css");
        yield* fs.writeFileString(outside, "body { color: red; }");
        yield* fs.symlink(outside, path.join(pluginsDir, "linked-css", "plugin.css"));

        const { plugins } = yield* registry.list;
        assert.strictEqual(plugins.length, 1);
        assert.match(plugins[0]?.problem ?? "", /symlink/i);
        assert.deepEqual(plugins[0]?.contributes, []);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("refuses writing to a symlinked plugin folder", () =>
    withPluginRegistry(
      {},
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { pluginsDir } = yield* ServerConfig.ServerConfig;
        const registry = yield* PluginRegistry.PluginRegistry;

        const targetDir = path.join(pluginsDir, "..", "external-plugin");
        yield* fs.makeDirectory(targetDir, { recursive: true });
        yield* fs.symlink(targetDir, path.join(pluginsDir, "linked-dir"));

        const failed = yield* registry
          .write({ id: "linked-dir", css: ":root { --x: 1; }" })
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "PluginOperationError");
        assert.strictEqual(failed.reason, "has_problem");
        assert.isFalse(yield* fs.exists(path.join(targetDir, "plugin.css")));
      }),
    ),
  );

  it.effect("toggles streamChanges emissions via setEnabled", () => {
    const css = "[data-chat-header] { border-bottom-width: 2px; }";
    return withPluginRegistry(
      {
        "bold-header": {
          manifest: JSON.stringify({ name: "bold-header", css: "./style.css" }),
          files: { "style.css": css },
        },
      },
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const settings = yield* ServerSettingsService;

        const seen =
          yield* Queue.unbounded<ReadonlyArray<{ readonly id: string; readonly css: string }>>();
        yield* Stream.runForEach(registry.streamChanges, (active) =>
          Queue.offer(seen, active),
        ).pipe(Effect.forkScoped);

        assert.deepEqual(yield* Queue.take(seen), []);

        const enabledResult = yield* registry.setEnabled("bold-header", true);
        assert.strictEqual(enabledResult.plugin.enabled, true);
        assert.deepEqual(yield* Queue.take(seen), [{ id: "bold-header", css }]);
        assert.deepEqual((yield* settings.getSettings).plugins, {
          "bold-header": { enabled: true },
        });

        const disabledResult = yield* registry.setEnabled("bold-header", false);
        assert.strictEqual(disabledResult.plugin.enabled, false);
        assert.deepEqual(yield* Queue.take(seen), []);
        assert.deepEqual((yield* settings.getSettings).plugins, {
          "bold-header": { enabled: false },
        });
      }),
    );
  });

  it.effect(
    "uninstalls by moving the folder to plugins-archive and dropping the settings entry",
    () => {
      const css = '[data-slot="sidebar"] { opacity: 0.95; }';
      return withPluginRegistry(
        {
          "soft-sidebar": {
            manifest: JSON.stringify({ name: "soft-sidebar", css: "./plugin.css" }),
            files: { "plugin.css": css },
          },
        },
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const settings = yield* ServerSettingsService;
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* registry.setEnabled("soft-sidebar", true);
          const seen =
            yield* Queue.unbounded<ReadonlyArray<{ readonly id: string; readonly css: string }>>();
          yield* Stream.runForEach(registry.streamChanges, (active) =>
            Queue.offer(seen, active),
          ).pipe(Effect.forkScoped);
          assert.deepEqual(yield* Queue.take(seen), [{ id: "soft-sidebar", css }]);

          const result = yield* registry.uninstall("soft-sidebar");
          assert.strictEqual(result.id, "soft-sidebar");
          assert.isTrue(
            result.archivedTo.startsWith(
              path.join(config.stateDir, "plugins-archive", "soft-sidebar-"),
            ),
          );

          assert.isFalse(yield* fs.exists(path.join(config.pluginsDir, "soft-sidebar")));
          assert.isTrue(
            yield* fs.exists(
              path.join(result.archivedTo, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE),
            ),
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(result.archivedTo, "plugin.css")),
            css,
          );
          assert.deepEqual((yield* settings.getSettings).plugins, {});
          assert.deepEqual((yield* registry.list).plugins, []);
          assert.deepEqual(yield* Queue.take(seen), []);

          const second = yield* registry.uninstall("soft-sidebar").pipe(Effect.flip);
          assert.strictEqual(second._tag, "PluginOperationError");
          assert.strictEqual(second.reason, "not_found");
        }),
      );
    },
  );

  it.effect(
    "write creates a disabled plugin with a revision and same content keeps the same revision id",
    () =>
      withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const css = "[data-thread-item] { padding-block: 3px; }";

          const created = yield* registry.write({
            id: "dense-rows",
            displayName: "Dense Rows",
            description: "Tighter thread list rows.",
            version: "0.1.0",
            css,
          });
          assert.strictEqual(created.created, true);
          assert.isUndefined(created.before);
          assert.match(created.after, /^[a-f0-9]{12}$/);
          assert.deepEqual(created.plugin, {
            id: "dense-rows",
            displayName: "Dense Rows",
            description: "Tighter thread list rows.",
            version: "0.1.0",
            enabled: false,
            contributes: ["css"],
            revision: created.after,
          });

          const readBack = yield* registry.read("dense-rows");
          assert.deepEqual(readBack, {
            displayName: "Dense Rows",
            description: "Tighter thread list rows.",
            version: "0.1.0",
            css,
          });

          const same = yield* registry.write({
            id: "dense-rows",
            displayName: "Dense Rows",
            description: "Tighter thread list rows.",
            version: "0.1.0",
            css,
          });
          assert.strictEqual(same.created, false);
          assert.strictEqual(same.before, created.after);
          assert.strictEqual(same.after, created.after);
        }),
      ),
  );

  it.effect(
    "write on an existing enabled plugin keeps it on, returns before and after, and restore(before) emits old CSS",
    () =>
      withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const cssV1 = "[data-chat-header] { border-bottom-width: 1px; }";
          const cssV2 = "[data-chat-header] { border-bottom-width: 3px; }";

          const first = yield* registry.write({
            id: "header-accent",
            displayName: "Header Accent",
            css: cssV1,
          });
          yield* registry.setEnabled("header-accent", true);

          const seen =
            yield* Queue.unbounded<ReadonlyArray<{ readonly id: string; readonly css: string }>>();
          yield* Stream.runForEach(registry.streamChanges, (active) =>
            Queue.offer(seen, active),
          ).pipe(Effect.forkScoped);
          assert.deepEqual(yield* Queue.take(seen), [{ id: "header-accent", css: cssV1 }]);

          const edited = yield* registry.write({
            id: "header-accent",
            displayName: "Header Accent",
            css: cssV2,
          });
          assert.strictEqual(edited.created, false);
          assert.strictEqual(edited.plugin.enabled, true);
          assert.strictEqual(edited.before, first.after);
          assert.notStrictEqual(edited.after, first.after);
          assert.strictEqual(edited.plugin.revision, edited.after);
          assert.deepEqual(yield* Queue.take(seen), [{ id: "header-accent", css: cssV2 }]);

          const restored = yield* registry.restore("header-accent", edited.before!);
          assert.strictEqual(restored.plugin.enabled, true);
          assert.strictEqual(restored.plugin.revision, first.after);
          assert.strictEqual((yield* registry.read("header-accent")).css, cssV1);
          assert.deepEqual(yield* Queue.take(seen), [{ id: "header-accent", css: cssV1 }]);

          const missingRev = yield* registry
            .restore("header-accent", "ffffffffffff")
            .pipe(Effect.flip);
          assert.strictEqual(missingRev._tag, "PluginOperationError");
          assert.strictEqual(missingRev.reason, "not_found");
        }),
      ),
  );

  it.effect("write with remote-fetching CSS fails invalid_css and changes no files", () =>
    withPluginRegistry(
      {},
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { pluginsDir } = yield* ServerConfig.ServerConfig;

        const failedNew = yield* registry
          .write({
            id: "remote-new",
            css: "@import url(https://example.com/a.css);",
          })
          .pipe(Effect.flip);
        assert.strictEqual(failedNew._tag, "PluginOperationError");
        assert.strictEqual(failedNew.reason, "invalid_css");
        assert.isFalse(yield* fs.exists(path.join(pluginsDir, "remote-new")));

        const originalCss = "[data-chat-header] { opacity: 0.9; }";
        const initial = yield* registry.write({
          id: "safe-plugin",
          css: originalCss,
        });
        const failedEdit = yield* registry
          .write({
            id: "safe-plugin",
            css: "body { background: url(https://example.com/bg.png); }",
          })
          .pipe(Effect.flip);
        assert.strictEqual(failedEdit._tag, "PluginOperationError");
        assert.strictEqual(failedEdit.reason, "invalid_css");

        const afterFailed = yield* registry.read("safe-plugin");
        assert.strictEqual(afterFailed.css, originalCss);
        assert.strictEqual((yield* registry.list).plugins[0]?.revision, initial.after);
      }),
    ),
  );

  it.effect("restore(after, true) after uninstall recreates and enables the plugin", () =>
    withPluginRegistry(
      {},
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const css = '[data-slot="sidebar"] { letter-spacing: 0.01em; }';

        const created = yield* registry.write({
          id: "restorable",
          displayName: "Restorable",
          css,
        });
        yield* registry.uninstall("restorable");
        assert.deepEqual((yield* registry.list).plugins, []);

        const restored = yield* registry.restore("restorable", created.after, true);
        assert.strictEqual(restored.plugin.enabled, true);
        assert.strictEqual(restored.plugin.revision, created.after);
        assert.strictEqual((yield* registry.read("restorable")).css, css);

        const snapshots = yield* registry.streamChanges.pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(Array.from(snapshots), [[{ id: "restorable", css }]]);
      }),
    ),
  );

  it.effect("history keeps only the newest 20 revisions per plugin", () =>
    withPluginRegistry(
      {},
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;

        const revisions: Array<string> = [];
        for (let index = 0; index < 25; index += 1) {
          const result = yield* registry.write({
            id: "history-cap",
            css: `:root { --step: ${index}; }`,
          });
          revisions.push(result.after);
        }

        const historyDir = path.join(stateDir, "plugins-history", "history-cap");
        const stored = yield* fs.readDirectory(historyDir);
        assert.strictEqual(stored.length, 20);
        const storedSet = new Set(stored);
        for (const oldest of revisions.slice(0, 5)) {
          assert.isFalse(storedSet.has(oldest), `expected oldest revision ${oldest} to be pruned`);
        }
        for (const newest of revisions.slice(5)) {
          assert.isTrue(storedSet.has(newest), `expected recent revision ${newest} to be kept`);
        }
      }),
    ),
  );

  it.effect(
    "lists a panel plugin with panels and contributes, and resolves its entry only when enabled",
    () =>
      withPluginRegistry(
        {
          pomodoro: {
            manifest: JSON.stringify({
              name: "pomodoro",
              displayName: "Pomodoro",
              panels: [{ id: "timer", title: "Pomodoro Timer", entry: "./timer.html" }],
            }),
            files: {
              "timer.html": "<!doctype html><html><body>Timer</body></html>",
            },
          },
        },
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { pluginsDir } = yield* ServerConfig.ServerConfig;

          const listed = yield* registry.list;
          assert.strictEqual(listed.plugins.length, 1);
          assert.deepEqual(listed.plugins[0], {
            id: "pomodoro",
            displayName: "Pomodoro",
            enabled: false,
            contributes: ["panel"],
            panels: [{ id: "timer", title: "Pomodoro Timer" }],
            revision: listed.plugins[0]!.revision,
          });

          const refusedOff = yield* registry
            .resolvePanelEntry("pomodoro", "timer")
            .pipe(Effect.flip);
          assert.strictEqual(refusedOff._tag, "PluginOperationError");
          assert.strictEqual(refusedOff.reason, "not_found");

          yield* registry.setEnabled("pomodoro", true);
          const active = yield* registry.streamChanges.pipe(Stream.take(1), Stream.runCollect);
          assert.deepEqual(Array.from(active)[0], [
            {
              id: "pomodoro",
              displayName: "Pomodoro",
              css: "",
              panels: [{ id: "timer", title: "Pomodoro Timer" }],
            },
          ]);
          const resolved = yield* registry.resolvePanelEntry("pomodoro", "timer");
          assert.strictEqual(
            resolved,
            yield* fs.realPath(path.join(pluginsDir, "pomodoro", "timer.html")),
          );

          const unknownPanel = yield* registry
            .resolvePanelEntry("pomodoro", "missing")
            .pipe(Effect.flip);
          assert.strictEqual(unknownPanel.reason, "not_found");

          yield* registry.setEnabled("pomodoro", false);
          const refusedAgain = yield* registry
            .resolvePanelEntry("pomodoro", "timer")
            .pipe(Effect.flip);
          assert.strictEqual(refusedAgain.reason, "not_found");
        }),
      ),
  );

  it.effect("reports problems for plugins without css or panels and for bad panel entries", () =>
    withPluginRegistry(
      {
        "empty-plugin": {
          manifest: JSON.stringify({ name: "empty-plugin" }),
        },
        "missing-panel": {
          manifest: JSON.stringify({
            name: "missing-panel",
            panels: [{ id: "main", title: "Main", entry: "./missing.html" }],
          }),
        },
        "oversized-panel": {
          manifest: JSON.stringify({
            name: "oversized-panel",
            panels: [{ id: "main", title: "Main", entry: "./big.html" }],
          }),
          files: {
            "big.html": "x".repeat(MCP_APP_MAX_HTML_BYTES + 1),
          },
        },
      },
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const { plugins } = yield* registry.list;
        const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

        assert.match(byId.get("empty-plugin")?.problem ?? "", /css.*panels|at least one/i);
        assert.match(byId.get("missing-panel")?.problem ?? "", /not found/i);
        assert.match(byId.get("oversized-panel")?.problem ?? "", /limit/i);
        for (const id of ["empty-plugin", "missing-panel", "oversized-panel"]) {
          assert.deepEqual(byId.get(id)?.contributes, []);
          assert.isUndefined(byId.get(id)?.panels);
        }
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("rejects a symlinked panel HTML entry with a problem", () =>
    withPluginRegistry(
      {
        "linked-panel": {
          manifest: JSON.stringify({
            name: "linked-panel",
            panels: [{ id: "main", title: "Main", entry: "./main.html" }],
          }),
        },
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { pluginsDir } = yield* ServerConfig.ServerConfig;
        const registry = yield* PluginRegistry.PluginRegistry;

        const outside = path.join(pluginsDir, "..", "outside.html");
        yield* fs.writeFileString(outside, "<html><body>Outside</body></html>");
        yield* fs.symlink(outside, path.join(pluginsDir, "linked-panel", "main.html"));

        const { plugins } = yield* registry.list;
        assert.strictEqual(plugins.length, 1);
        assert.match(plugins[0]?.problem ?? "", /symlink/i);
        assert.deepEqual(plugins[0]?.contributes, []);
      }),
    ),
  );

  it.effect("keeps CSS-only revision ids equal to sha256(manifest + \\0 + css).slice(0, 12)", () =>
    withPluginRegistry(
      {},
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { pluginsDir } = yield* ServerConfig.ServerConfig;

        const css = "[data-thread-item] { padding-block: 4px; }";
        const created = yield* registry.write({
          id: "css-only-hash",
          displayName: "CSS Only",
          css,
        });
        const manifestText = yield* fs.readFileString(
          path.join(pluginsDir, "css-only-hash", PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE),
        );
        const digest = yield* Effect.promise(async () => {
          const buffer = await globalThis.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${manifestText}\0${css}`),
          );
          return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 12);
        });
        assert.strictEqual(created.after, digest);
      }),
    ),
  );

  it.effect(
    "write with panels updates files and restore(before) brings back old HTML and removes new file",
    () =>
      withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { pluginsDir } = yield* ServerConfig.ServerConfig;

          const first = yield* registry.write({
            id: "notes-panel",
            displayName: "Notes",
            panels: [{ id: "notes", title: "Notes", html: "<html><body>v1</body></html>" }],
          });
          assert.deepEqual(first.plugin.contributes, ["panel"]);
          assert.deepEqual(first.plugin.panels, [{ id: "notes", title: "Notes" }]);
          yield* registry.setEnabled("notes-panel", true);
          const unlistedPath = path.join(pluginsDir, "notes-panel", "readme.html");
          yield* fs.writeFileString(unlistedPath, "<p>mine</p>");

          const seen = yield* Queue.unbounded<ReadonlyArray<EnvironmentPlugin>>();
          yield* Stream.runForEach(registry.streamChanges, (active) =>
            Queue.offer(seen, active),
          ).pipe(Effect.forkScoped);
          assert.deepEqual(yield* Queue.take(seen), [
            {
              id: "notes-panel",
              displayName: "Notes",
              css: "",
              panels: [{ id: "notes", title: "Notes" }],
            },
          ]);

          const second = yield* registry.write({
            id: "notes-panel",
            displayName: "Notes",
            panels: [{ id: "board", title: "Board", html: "<html><body>v2</body></html>" }],
          });
          assert.strictEqual(second.plugin.enabled, true);
          assert.strictEqual(second.before, first.after);
          assert.notStrictEqual(second.after, first.after);
          assert.isFalse(yield* fs.exists(path.join(pluginsDir, "notes-panel", "notes.html")));
          assert.isTrue(yield* fs.exists(path.join(pluginsDir, "notes-panel", "board.html")));
          assert.isTrue(yield* fs.exists(unlistedPath));
          assert.deepEqual(yield* Queue.take(seen), [
            {
              id: "notes-panel",
              displayName: "Notes",
              css: "",
              panels: [{ id: "board", title: "Board" }],
            },
          ]);

          const restored = yield* registry.restore("notes-panel", second.before!);
          assert.strictEqual(restored.plugin.revision, first.after);
          assert.isTrue(yield* fs.exists(path.join(pluginsDir, "notes-panel", "notes.html")));
          assert.isFalse(yield* fs.exists(path.join(pluginsDir, "notes-panel", "board.html")));
          assert.isTrue(yield* fs.exists(unlistedPath));
          const readBack = yield* registry.read("notes-panel");
          assert.deepEqual(readBack.panels, [
            { id: "notes", title: "Notes", html: "<html><body>v1</body></html>" },
          ]);
          assert.deepEqual(yield* Queue.take(seen), [
            {
              id: "notes-panel",
              displayName: "Notes",
              css: "",
              panels: [{ id: "notes", title: "Notes" }],
            },
          ]);
        }),
      ),
  );

  it.effect(
    "tracks worker powers hash: code-only edits keep approval while folder, network, or schedule changes drop it",
    () =>
      withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vaultDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-vault-" });
          const vaultReal = yield* fs.realPath(vaultDir);

          const created = yield* registry.write({
            id: "vault-sync",
            displayName: "Vault Sync",
            worker: {
              code: "export default function (t3) { t3.log('v1'); }\n",
              everyMinutes: 15,
              folders: [{ id: "vault", label: "Obsidian vault", access: "read" }],
              network: false,
            },
          });
          assert.deepEqual(created.plugin.contributes, ["worker"]);
          assert.strictEqual(created.plugin.worker?.status, "stopped");

          // Install enables and approves powers; missing folder keeps status needs-folder.
          const installed = yield* registry.setEnabled("vault-sync", true, { approveWorker: true });
          assert.strictEqual(installed.plugin.worker?.status, "needs-folder");

          // UNC paths and nonexistent paths are rejected; valid dir is canonicalized.
          const uncFailed = yield* registry
            .setWorkerFolder("vault-sync", "vault", "\\\\server\\share")
            .pipe(Effect.flip);
          assert.strictEqual(uncFailed.reason, "invalid_folder");
          const missingFailed = yield* registry
            .setWorkerFolder("vault-sync", "vault", path.join(vaultDir, "does-not-exist"))
            .pipe(Effect.flip);
          assert.strictEqual(missingFailed.reason, "invalid_folder");

          const withFolder = yield* registry.setWorkerFolder("vault-sync", "vault", vaultDir);
          assert.strictEqual(withFolder.plugin.worker?.folders[0]?.path, vaultReal);
          assert.strictEqual(withFolder.plugin.worker?.status, "stopped");

          // Code-only edit keeps approval (not needs-approval).
          const codeEdit = yield* registry.write({
            id: "vault-sync",
            displayName: "Vault Sync",
            worker: {
              code: "export default function (t3) { t3.log('v2'); }\n",
              everyMinutes: 15,
              folders: [{ id: "vault", label: "Obsidian vault", access: "read" }],
              network: false,
            },
          });
          assert.notStrictEqual(codeEdit.after, created.after);
          assert.notStrictEqual(codeEdit.plugin.worker?.status, "needs-approval");

          // Widening folder access drops approval.
          const folderEdit = yield* registry.write({
            id: "vault-sync",
            displayName: "Vault Sync",
            worker: {
              code: "export default function (t3) { t3.log('v2'); }\n",
              everyMinutes: 15,
              folders: [{ id: "vault", label: "Obsidian vault", access: "write" }],
              network: false,
            },
          });
          assert.strictEqual(folderEdit.plugin.worker?.status, "needs-approval");
          // Approving the revision the user reviewed fails once the plugin has moved past it.
          const staleApprove = yield* registry
            .approveWorker("vault-sync", codeEdit.after)
            .pipe(Effect.flip);
          assert.strictEqual(staleApprove.reason, "changed");
          const staleInstall = yield* registry
            .setEnabled("vault-sync", true, { approveWorker: true, revision: codeEdit.after })
            .pipe(Effect.flip);
          assert.strictEqual(staleInstall.reason, "changed");
          assert.strictEqual(
            (yield* registry.list).plugins.find((plugin) => plugin.id === "vault-sync")?.worker
              ?.status,
            "needs-approval",
          );
          const approvedAfterFolder = yield* registry.approveWorker("vault-sync", folderEdit.after);
          assert.notStrictEqual(approvedAfterFolder.plugin.worker?.status, "needs-approval");

          // Enabling network drops approval.
          const networkEdit = yield* registry.write({
            id: "vault-sync",
            displayName: "Vault Sync",
            worker: {
              code: "export default function (t3) { t3.log('v2'); }\n",
              everyMinutes: 15,
              folders: [{ id: "vault", label: "Obsidian vault", access: "write" }],
              network: true,
            },
          });
          assert.strictEqual(networkEdit.plugin.worker?.status, "needs-approval");
          yield* registry.approveWorker("vault-sync");

          // Changing schedule drops approval, and Undo restores previous approved powers.
          const scheduleEdit = yield* registry.write({
            id: "vault-sync",
            displayName: "Vault Sync",
            worker: {
              code: "export default function (t3) { t3.log('v3'); }\n",
              everyMinutes: 30,
              folders: [{ id: "vault", label: "Obsidian vault", access: "write" }],
              network: true,
            },
          });
          assert.strictEqual(scheduleEdit.plugin.worker?.status, "needs-approval");

          const undone = yield* registry.restore("vault-sync", scheduleEdit.before!);
          assert.notStrictEqual(undone.plugin.worker?.status, "needs-approval");
          const readBack = yield* registry.read("vault-sync");
          assert.strictEqual(readBack.worker?.everyMinutes, 15);
          assert.strictEqual(
            readBack.worker?.code,
            "export default function (t3) { t3.log('v2'); }\n",
          );
        }),
      ),
  );

  it.effect(
    "loads .claude-plugin fallback, parses skills/commands/AGENTS.md/mcp/hooks/agents with collision handling, and prefers .t3-plugin",
    () =>
      withPluginRegistry(
        {
          "claude-pack": {
            claudeManifest: JSON.stringify({
              name: "claude-pack",
              description: "Claude Code plugin pack.",
              author: { name: "Upstream" },
              hooks: "./hooks/hooks.json",
              mcpServers: { docs: { command: "npx" } },
            }),
            files: {
              "AGENTS.md": "Always cite line numbers.",
              "skills/standup/SKILL.md": [
                "---",
                "name: standup",
                "description: Daily standup summary",
                'argument-hint: "[focus]"',
                "disable-model-invocation: true",
                "---",
                "",
                "Write standup for $ARGUMENTS.",
              ].join("\n"),
              "skills/review/SKILL.md": [
                "---",
                "description: Deep code review",
                "user-invocable: false",
                "---",
                "",
                "Review carefully.",
              ].join("\n"),
              // Collides with skills/standup: skill must win.
              "commands/standup.md": "Shadowed legacy command",
              "commands/release.md": "Prepare release $0",
              // Nested folder inside commands/ must be ignored.
              "commands/nested/ignored.md": "Nested ignored",
              "hooks/hooks.json": JSON.stringify({
                hooks: {
                  PreToolUse: [
                    {
                      matcher: "Bash",
                      hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/guard.sh" }],
                    },
                  ],
                },
              }),
              ".mcp.json": "{}",
              "agents/reviewer.md": [
                "---",
                "description: Code reviewer",
                "tools: Read, Grep",
                "---",
                "",
                "Review diffs carefully.",
              ].join("\n"),
            },
          },
          "both-manifests": {
            manifest: JSON.stringify({
              name: "both-manifests",
              displayName: "T3 Wins",
            }),
            claudeManifest: JSON.stringify({
              name: "both-manifests",
              displayName: "Claude Loses",
            }),
            files: {
              "AGENTS.md": "Rule from both-manifests.",
            },
          },
        },
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const listed = yield* registry.list;
          const byId = new Map(listed.plugins.map((plugin) => [plugin.id, plugin]));

          const claudePack = byId.get("claude-pack");
          assert.isDefined(claudePack);
          assert.isUndefined(claudePack?.problem);
          assert.deepEqual(claudePack?.contributes, [
            "command",
            "skill",
            "instructions",
            "mcp",
            "hook",
            "agent",
          ]);
          assert.deepEqual(claudePack?.commands, ["standup", "release"]);
          assert.deepEqual(claudePack?.skills, ["review", "release"]);
          assert.isUndefined(claudePack?.unsupported);
          assert.strictEqual(claudePack?.mcpServers?.[0]?.name, "docs");
          assert.strictEqual(claudePack?.hooks?.[0]?.event, "PreToolUse");
          assert.deepEqual(claudePack?.agents, [
            { name: PluginId.make("reviewer"), description: "Code reviewer" },
          ]);

          assert.strictEqual(byId.get("both-manifests")?.displayName, "T3 Wins");

          const detail = yield* registry.read("claude-pack");
          assert.strictEqual(detail.instructions, "Always cite line numbers.");
          assert.deepEqual(detail.mcpServers, { docs: { command: "npx" } });
          assert.strictEqual(detail.hooks?.PreToolUse?.[0]?.matcher, "Bash");
          assert.strictEqual(detail.agents?.[0]?.name, "reviewer");
          assert.deepEqual(
            detail.skills?.map((skill) => ({
              name: skill.name,
              userInvocable: skill.userInvocable,
              modelInvocable: skill.modelInvocable,
              body: skill.body,
            })),
            [
              {
                name: "review",
                userInvocable: false,
                modelInvocable: true,
                body: "Review carefully.",
              },
              {
                name: "standup",
                userInvocable: true,
                modelInvocable: false,
                body: "Write standup for $ARGUMENTS.",
              },
              {
                name: "release",
                userInvocable: true,
                modelInvocable: true,
                body: "Prepare release $0",
              },
            ],
          );

          // Enabling without external approval still delivers skills, commands, instructions, and agents,
          // while holding back hooks until approved.
          yield* registry.setEnabled("claude-pack", true);
          const turnCtx = yield* registry.getTurnContext(ProjectId.make("proj-1"));
          assert.strictEqual(turnCtx.contextPlugins.length, 1);
          assert.strictEqual(turnCtx.contextPlugins[0]?.instructions, "Always cite line numbers.");
          assert.deepEqual(
            turnCtx.contextPlugins[0]?.skills?.map((skill) => skill.name),
            ["review", "release"],
          );
          assert.deepEqual(
            turnCtx.commands.map((command) => command.name),
            ["standup", "release"],
          );
          assert.strictEqual(turnCtx.commands[0]?.body, "Write standup for $ARGUMENTS.");
          assert.deepEqual(turnCtx.hooks, {});
          assert.strictEqual(turnCtx.agents?.length, 1);
          assert.strictEqual(turnCtx.agents?.[0]?.name, "reviewer");
        }),
      ),
  );

  it.effect(
    "reports problems for oversized skills, oversized AGENTS.md, bad skill names, and >32 skills",
    () => {
      const tooManySkills: Record<string, string> = {};
      for (let i = 0; i <= PLUGIN_MAX_SKILLS; i += 1) {
        tooManySkills[`skills/skill-${i}/SKILL.md`] = `Skill ${i}`;
      }
      return withPluginRegistry(
        {
          "bad-skill-name": {
            manifest: JSON.stringify({ name: "bad-skill-name" }),
            files: { "skills/Bad_Name/SKILL.md": "Body" },
          },
          "oversized-skill": {
            manifest: JSON.stringify({ name: "oversized-skill" }),
            files: { "skills/huge/SKILL.md": "a".repeat(PLUGIN_SKILL_MAX_BYTES + 1) },
          },
          "oversized-instructions": {
            manifest: JSON.stringify({ name: "oversized-instructions" }),
            files: { "AGENTS.md": "b".repeat(PLUGIN_INSTRUCTIONS_MAX_BYTES + 1) },
          },
          "too-many-skills": {
            manifest: JSON.stringify({ name: "too-many-skills" }),
            files: tooManySkills,
          },
        },
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const { plugins } = yield* registry.list;
          const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

          assert.match(byId.get("bad-skill-name")?.problem ?? "", /valid plugin id/i);
          assert.match(byId.get("oversized-skill")?.problem ?? "", /32 KB/i);
          assert.match(byId.get("oversized-instructions")?.problem ?? "", /8 KB/i);
          assert.match(byId.get("too-many-skills")?.problem ?? "", /32/);
        }),
      );
    },
  );

  it.effect(
    "write and restore track skills and AGENTS.md revisions, keep omitted parts unchanged, and delete AGENTS.md on empty string",
    () =>
      withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { pluginsDir } = yield* ServerConfig.ServerConfig;

          const first = yield* registry.write({
            id: "daily",
            displayName: "Daily",
            instructions: "Keep answers short.",
            skills: [
              {
                name: PluginId.make("standup"),
                description: "Daily standup",
                argumentHint: "[focus]",
                userInvocable: true,
                modelInvocable: false,
                body: "Summarize commits for $ARGUMENTS.",
              },
            ],
          });
          assert.deepEqual(first.plugin.contributes, ["command", "instructions"]);
          assert.deepEqual(first.plugin.commands, ["standup"]);
          assert.isUndefined(first.plugin.skills);
          yield* registry.setEnabled("daily", true);

          // Omitting skills keeps them unchanged; empty instructions removes AGENTS.md.
          const second = yield* registry.write({
            id: "daily",
            instructions: "",
          });
          assert.notStrictEqual(second.after, first.after);
          assert.strictEqual(second.before, first.after);
          assert.isFalse(yield* fs.exists(path.join(pluginsDir, "daily", "AGENTS.md")));
          assert.deepEqual(second.plugin.contributes, ["command"]);
          assert.deepEqual(second.plugin.commands, ["standup"]);

          // Replacing skills removes the old skill file and changes revision.
          const third = yield* registry.write({
            id: "daily",
            skills: [
              {
                name: PluginId.make("retro"),
                description: "Sprint retro",
                userInvocable: true,
                modelInvocable: true,
                body: "List wins and gaps.",
              },
            ],
          });
          assert.notStrictEqual(third.after, second.after);
          assert.isFalse(
            yield* fs.exists(path.join(pluginsDir, "daily", "skills", "standup", "SKILL.md")),
          );
          assert.isTrue(
            yield* fs.exists(path.join(pluginsDir, "daily", "skills", "retro", "SKILL.md")),
          );

          // Undo to first revision restores AGENTS.md and standup, removes retro.
          const restored = yield* registry.restore("daily", first.after);
          assert.strictEqual(restored.plugin.revision, first.after);
          assert.isTrue(yield* fs.exists(path.join(pluginsDir, "daily", "AGENTS.md")));
          assert.isTrue(
            yield* fs.exists(path.join(pluginsDir, "daily", "skills", "standup", "SKILL.md")),
          );
          assert.isFalse(
            yield* fs.exists(path.join(pluginsDir, "daily", "skills", "retro", "SKILL.md")),
          );
          const readBack = yield* registry.read("daily");
          assert.strictEqual(readBack.instructions, "Keep answers short.");
          assert.deepEqual(
            readBack.skills?.map((skill) => skill.name),
            ["standup"],
          );
        }),
      ),
  );

  it.effect(
    "repo plugins start off, require matching revision to enable, stop applying after edit, ignore css/panels/worker, and refuse uninstall/restore",
    () => {
      const projectA = ProjectId.make("project-a");
      const projectB = ProjectId.make("project-b");
      return withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const baseDir = path.dirname(stateDir);

          // Starts off, ignores CSS/panels/worker and reports them unsupported.
          const listed1 = yield* registry.list;
          assert.strictEqual(listed1.repoPlugins?.length, 1);
          const initialRepo = listed1.repoPlugins![0]!;
          assert.strictEqual(initialRepo.id, "team-kit");
          assert.strictEqual(initialRepo.projectId, projectA);
          assert.strictEqual(initialRepo.enabled, false);
          assert.strictEqual(initialRepo.repoStatus, "off");
          assert.deepEqual(initialRepo.contributes, ["command", "instructions"]);
          assert.deepEqual(initialRepo.commands, ["deploy"]);
          assert.deepEqual(initialRepo.unsupported, ["hooks", "css", "panels", "worker"]);
          assert.isUndefined(initialRepo.panels);
          assert.isUndefined(initialRepo.worker);

          // Off repo plugin is NOT delivered to turns.
          const ctxOff = yield* registry.getTurnContext(projectA);
          assert.deepEqual(ctxOff.contextPlugins, []);
          assert.deepEqual(ctxOff.commands, []);

          // Enabling without revision or with stale revision fails with "changed".
          const missingRev = yield* registry
            .setEnabled("team-kit", true, { projectId: projectA })
            .pipe(Effect.flip);
          assert.strictEqual(missingRev.reason, "changed");
          const staleRev = yield* registry
            .setEnabled("team-kit", true, { projectId: projectA, revision: "000000000000" })
            .pipe(Effect.flip);
          assert.strictEqual(staleRev.reason, "changed");

          // Enabling with current revision activates for projectA only.
          assert.isString(initialRepo.revision);
          const initialRevision = initialRepo.revision!;
          const enabledRes = yield* registry.setEnabled("team-kit", true, {
            projectId: projectA,
            revision: initialRevision,
          });
          assert.strictEqual(enabledRes.plugin.enabled, true);
          assert.strictEqual(enabledRes.plugin.repoStatus, "on");

          const ctxOnA = yield* registry.getTurnContext(projectA);
          assert.strictEqual(ctxOnA.contextPlugins.length, 1);
          assert.strictEqual(ctxOnA.contextPlugins[0]?.instructions, "Follow repo release rules.");
          assert.deepEqual(
            ctxOnA.commands.map((cmd) => cmd.name),
            ["deploy"],
          );
          const ctxOnB = yield* registry.getTurnContext(projectB);
          assert.deepEqual(ctxOnB.contextPlugins, []);
          assert.deepEqual(ctxOnB.commands, []);

          // Active repo plugin emits its commands on streamChanges with projectId and empty CSS.
          const activeSnap = yield* registry.streamChanges.pipe(Stream.take(1), Stream.runCollect);
          assert.deepEqual(Array.from(activeSnap), [
            [
              {
                id: "team-kit",
                displayName: "Team Kit",
                css: "",
                commands: [{ name: "deploy", description: "Deploy app" }],
                projectId: projectA,
              },
            ],
          ]);

          // Editing a file in the repo plugin moves it to "changed" and stops applying it.
          const agentsPath = path.join(
            baseDir,
            "projects",
            projectA,
            ".t3",
            "plugins",
            "team-kit",
            "AGENTS.md",
          );
          yield* fs.writeFileString(agentsPath, "Tampered instructions.");

          const listedChanged = yield* registry.list;
          const changedRepo = listedChanged.repoPlugins![0]!;
          assert.strictEqual(changedRepo.repoStatus, "changed");
          assert.strictEqual(changedRepo.enabled, false);
          assert.notStrictEqual(changedRepo.revision, initialRepo.revision);

          const ctxChanged = yield* registry.getTurnContext(projectA);
          assert.deepEqual(ctxChanged.contextPlugins, []);
          assert.deepEqual(ctxChanged.commands, []);

          // Old revision fails; new revision re-enables.
          assert.isString(changedRepo.revision);
          const changedRevision = changedRepo.revision!;
          const oldFail = yield* registry
            .setEnabled("team-kit", true, { projectId: projectA, revision: initialRevision })
            .pipe(Effect.flip);
          assert.strictEqual(oldFail.reason, "changed");

          const reEnabled = yield* registry.setEnabled("team-kit", true, {
            projectId: projectA,
            revision: changedRevision,
          });
          assert.strictEqual(reEnabled.plugin.repoStatus, "on");
          assert.strictEqual(
            (yield* registry.getTurnContext(projectA)).contextPlugins[0]?.instructions,
            "Tampered instructions.",
          );

          // Turning off clears approval back to "off".
          const turnedOff = yield* registry.setEnabled("team-kit", false, { projectId: projectA });
          assert.strictEqual(turnedOff.plugin.repoStatus, "off");
          assert.strictEqual(turnedOff.plugin.enabled, false);

          // Uninstall and restore on repo plugins fail clearly.
          const uninstallErr = yield* registry.uninstall("team-kit", projectA).pipe(Effect.flip);
          assert.strictEqual(uninstallErr.reason, "repo_plugin_readonly");
          const uninstallNoProjErr = yield* registry.uninstall("team-kit").pipe(Effect.flip);
          assert.strictEqual(uninstallNoProjErr.reason, "repo_plugin_readonly");
          const restoreErr = yield* registry
            .restore("team-kit", initialRepo.revision!, false, { projectId: projectA })
            .pipe(Effect.flip);
          assert.strictEqual(restoreErr.reason, "repo_plugin_readonly");
        }),
        DEFAULT_SERVER_SETTINGS,
        [
          {
            projectId: projectA,
            title: "Project A",
            plugins: {
              "team-kit": {
                manifest: JSON.stringify({
                  name: "team-kit",
                  displayName: "Team Kit",
                  css: "./plugin.css",
                  panels: [{ id: "tab", title: "Tab", entry: "./tab.html" }],
                  worker: { entry: "./worker.mjs" },
                }),
                files: {
                  "plugin.css": "body { color: red; }",
                  "tab.html": "<html></html>",
                  "worker.mjs": "export default () => {};",
                  "hooks/hooks.json": "{}",
                  "AGENTS.md": "Follow repo release rules.",
                  "skills/deploy/SKILL.md": [
                    "---",
                    "name: deploy",
                    "description: Deploy app",
                    "disable-model-invocation: true",
                    "---",
                    "",
                    "Deploy $ARGUMENTS.",
                  ].join("\n"),
                },
              },
            },
          },
          {
            projectId: projectB,
            title: "Project B",
            plugins: {},
          },
        ],
      );
    },
  );

  it.effect(
    "reports part problems for invalid/oversized MCP/hooks/agents without blocking other parts, and marks unsupported MCP features not-runnable",
    () =>
      withPluginRegistry(
        {
          "mixed-mcp": {
            manifest: JSON.stringify({
              name: "mixed-mcp",
              mcpServers: "./extra-mcp.json",
              hooks: {
                PreToolUse: [
                  {
                    matcher: "Bash",
                    hooks: [{ type: "command", command: "echo ok" }],
                  },
                ],
              },
            }),
            files: {
              "AGENTS.md": "Keep loading despite not-runnable servers.",
              ".mcp.json": JSON.stringify({
                mcpServers: {
                  good: { command: "node", args: ["server.mjs"] },
                  oauthSrv: {
                    type: "http",
                    url: "https://example.test/mcp",
                    oauth: { clientId: "x" },
                  },
                  helperSrv: {
                    type: "http",
                    url: "https://example.test/mcp",
                    headersHelper: "./hdr.sh",
                  },
                  wsSrv: { type: "ws", url: "wss://example.test/mcp" },
                  mcpbSrv: { type: "http", url: "https://example.test/pack.mcpb" },
                  projDirSrv: { command: "${CLAUDE_PROJECT_DIR}/run.sh" },
                  userCfgSrv: { command: "node", env: { KEY: "${user_config.api_key}" } },
                },
              }),
              "extra-mcp.json": JSON.stringify({
                remoteOk: { type: "streamable-http", url: "https://example.test/ok" },
              }),
            },
          },
          "broken-parts": {
            manifest: JSON.stringify({ name: "broken-parts" }),
            files: {
              "AGENTS.md": "Instructions still load.",
              ".mcp.json": "{not valid json",
              "hooks/hooks.json": JSON.stringify({
                hooks: { BadEvent: "not-an-array" },
              }),
              "agents/missing-desc.md": "# No frontmatter description",
            },
          },
          "missing-type-url": {
            manifest: JSON.stringify({ name: "missing-type-url" }),
            files: {
              "AGENTS.md": "Still loads.",
              ".mcp.json": JSON.stringify({
                bad: { url: "https://example.test/mcp" },
              }),
            },
          },
        },
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const { plugins } = yield* registry.list;
          const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

          const mixed = byId.get("mixed-mcp");
          assert.isDefined(mixed);
          assert.isUndefined(mixed?.problem);
          const serversByName = new Map(
            (mixed?.mcpServers ?? []).map((server) => [server.name, server]),
          );
          assert.strictEqual(serversByName.get("good")?.status, "stopped");
          assert.strictEqual(serversByName.get("remoteOk")?.status, "stopped");
          assert.strictEqual(serversByName.get("remoteOk")?.transport, "http");
          assert.strictEqual(serversByName.get("oauthSrv")?.status, "not-runnable");
          assert.match(serversByName.get("oauthSrv")?.reason ?? "", /oauth/i);
          assert.strictEqual(serversByName.get("helperSrv")?.status, "not-runnable");
          assert.match(serversByName.get("helperSrv")?.reason ?? "", /headersHelper/i);
          assert.strictEqual(serversByName.get("wsSrv")?.status, "not-runnable");
          assert.match(serversByName.get("wsSrv")?.reason ?? "", /ws/i);
          assert.strictEqual(serversByName.get("mcpbSrv")?.status, "not-runnable");
          assert.match(serversByName.get("mcpbSrv")?.reason ?? "", /mcpb/i);
          assert.strictEqual(serversByName.get("projDirSrv")?.status, "not-runnable");
          assert.match(serversByName.get("projDirSrv")?.reason ?? "", /CLAUDE_PROJECT_DIR/);
          assert.strictEqual(serversByName.get("userCfgSrv")?.status, "not-runnable");
          assert.match(serversByName.get("userCfgSrv")?.reason ?? "", /user_config/);

          const broken = byId.get("broken-parts");
          assert.isDefined(broken);
          assert.isUndefined(broken?.problem);
          assert.deepEqual(broken?.contributes, ["instructions"]);
          assert.isAtLeast(broken?.partProblems?.length ?? 0, 3);

          const missingType = byId.get("missing-type-url");
          assert.isDefined(missingType);
          assert.isUndefined(missingType?.problem);
          assert.isTrue((missingType?.partProblems ?? []).some((problem) => /type/i.test(problem)));
        }),
      ),
  );

  it.effect(
    "gates MCP servers and hooks behind externalApproval, re-asks only on MCP/hook config changes, supports Undo, and allows removing approval",
    () =>
      withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const settings = yield* ServerSettingsService;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { pluginsDir } = yield* ServerConfig.ServerConfig;

          const created = yield* registry.write({
            id: "ext-demo",
            displayName: "Ext Demo",
            instructions: "Rule v1.",
            mcpServers: {
              docs: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/srv.mjs"] },
            },
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [
                    {
                      type: "command",
                      command: "${CLAUDE_PLUGIN_ROOT}/check.sh",
                      args: ["${CLAUDE_PLUGIN_DATA}/log.txt"],
                    },
                  ],
                },
              ],
            },
            agents: [
              {
                name: PluginId.make("auditor"),
                description: "Audit shell commands",
                tools: ["Read"],
                model: "sonnet",
                body: "Be thorough.",
              },
            ],
          });

          // Enabled without approveExternal -> needs-approval, no hooks, no MCP desired specs.
          const enabledUnapproved = yield* registry.setEnabled("ext-demo", true);
          assert.strictEqual(enabledUnapproved.plugin.externalStatus, "needs-approval");
          assert.strictEqual(enabledUnapproved.plugin.mcpServers?.[0]?.status, "needs-approval");

          const unapprovedSpecs = yield* registry.streamMcpDesiredState.pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.deepEqual(Array.from(unapprovedSpecs), [[]]);
          const unapprovedTurn = yield* registry.getTurnContext(ProjectId.make("p1"));
          assert.deepEqual(unapprovedTurn.hooks, {});
          assert.strictEqual(unapprovedTurn.agents?.length, 1);

          // Stale revision fails with changed.
          const staleErr = yield* registry
            .setEnabled("ext-demo", true, {
              approveExternal: true,
              revision: "000000000000",
            })
            .pipe(Effect.flip);
          assert.strictEqual(staleErr.reason, "changed");

          // Approve with matching revision -> approved, specs emitted, hooks expanded.
          const approved = yield* registry.setEnabled("ext-demo", true, {
            approveExternal: true,
            revision: created.after,
          });
          assert.strictEqual(approved.plugin.externalStatus, "approved");

          const approvedSpecs = yield* registry.streamMcpDesiredState.pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.strictEqual(Array.from(approvedSpecs)[0]?.length, 1);
          assert.strictEqual(Array.from(approvedSpecs)[0]?.[0]?.serverName, "docs");

          const approvedTurn = yield* registry.getTurnContext(ProjectId.make("p1"));
          const hookCmd = approvedTurn.hooks?.PreToolUse?.[0]?.hooks[0];
          assert.isDefined(hookCmd);
          if (hookCmd?.type === "command") {
            assert.isFalse(hookCmd.command.includes("${CLAUDE_PLUGIN_ROOT}"));
            assert.isTrue(hookCmd.command.endsWith("check.sh"));
            assert.isFalse(hookCmd.args?.[0]?.includes("${CLAUDE_PLUGIN_DATA}"));
            assert.isTrue(yield* fs.exists(path.dirname(hookCmd.args![0]!)));
          }

          // Text-only edit keeps external approval intact.
          const textEdit = yield* registry.write({
            id: "ext-demo",
            instructions: "Rule v2.",
          });
          assert.strictEqual(textEdit.plugin.externalStatus, "approved");

          // MCP config edit changes external hash and drops approval.
          const mcpEdit = yield* registry.write({
            id: "ext-demo",
            mcpServers: {
              docs: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/srv-v2.mjs"] },
            },
          });
          assert.strictEqual(mcpEdit.plugin.externalStatus, "needs-approval");
          const afterEditSpecs = yield* registry.streamMcpDesiredState.pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.deepEqual(Array.from(afterEditSpecs), [[]]);

          // Undo restores previous .mcp.json and matches the stored approval again.
          const undone = yield* registry.restore("ext-demo", mcpEdit.before!);
          assert.strictEqual(undone.plugin.externalStatus, "approved");
          const readBack = yield* registry.read("ext-demo");
          assert.deepEqual(readBack.mcpServers, {
            docs: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/srv.mjs"] },
          });

          // Removing approval via settings null patch stops MCP specs and hooks.
          yield* settings.updateSettings({
            plugins: { "ext-demo": { externalApproval: null } },
          });
          const afterRevoke = yield* registry.list;
          assert.strictEqual(
            afterRevoke.plugins.find((plugin) => plugin.id === "ext-demo")?.externalStatus,
            "needs-approval",
          );
          const revokedTurn = yield* registry.getTurnContext(ProjectId.make("p1"));
          assert.deepEqual(revokedTurn.hooks, {});

          // Empty {} removes .mcp.json and hooks/hooks.json; [] removes agents/.
          yield* registry.write({
            id: "ext-demo",
            mcpServers: {},
            hooks: {},
            agents: [],
          });
          assert.isFalse(yield* fs.exists(path.join(pluginsDir, "ext-demo", ".mcp.json")));
          assert.isFalse(
            yield* fs.exists(path.join(pluginsDir, "ext-demo", "hooks", "hooks.json")),
          );
          assert.isFalse(
            yield* fs.exists(path.join(pluginsDir, "ext-demo", "agents", "auditor.md")),
          );
        }),
      ),
  );

  it.effect(
    "repo plugins load agents when enabled while keeping MCP servers and hooks unsupported",
    () => {
      const projectA = ProjectId.make("project-repo-agents");
      return withPluginRegistry(
        {},
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const listed = yield* registry.list;
          const repoPlugin = listed.repoPlugins?.find((plugin) => plugin.id === "repo-ext");
          assert.isDefined(repoPlugin);
          assert.deepEqual(repoPlugin?.contributes, ["agent"]);
          assert.deepEqual(repoPlugin?.agents, [
            { name: PluginId.make("planner"), description: "Plan repo changes" },
          ]);
          assert.deepEqual(repoPlugin?.unsupported, ["hooks", "mcp"]);
          assert.isUndefined(repoPlugin?.mcpServers);
          assert.isUndefined(repoPlugin?.hooks);

          // Off -> no agents delivered.
          assert.deepEqual((yield* registry.getTurnContext(projectA)).agents, []);

          // On -> agents delivered, hooks still empty, MCP desired specs still empty.
          yield* registry.setEnabled("repo-ext", true, {
            projectId: projectA,
            revision: repoPlugin!.revision!,
          });
          const ctx = yield* registry.getTurnContext(projectA);
          assert.strictEqual(ctx.agents?.length, 1);
          assert.strictEqual(ctx.agents?.[0]?.name, "planner");
          assert.deepEqual(ctx.hooks, {});
          const specs = yield* registry.streamMcpDesiredState.pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.deepEqual(Array.from(specs), [[]]);
        }),
        DEFAULT_SERVER_SETTINGS,
        [
          {
            projectId: projectA,
            title: "Project Repo Agents",
            plugins: {
              "repo-ext": {
                manifest: JSON.stringify({ name: "repo-ext" }),
                files: {
                  ".mcp.json": JSON.stringify({
                    docs: { command: "node", args: ["srv.mjs"] },
                  }),
                  "hooks/hooks.json": JSON.stringify({
                    hooks: {
                      Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }],
                    },
                  }),
                  "agents/planner.md": [
                    "---",
                    "description: Plan repo changes",
                    "tools: Read, Glob",
                    "permissionMode: bypassPermissions",
                    "---",
                    "",
                    "Produce a concise plan.",
                  ].join("\n"),
                },
              },
            },
          },
        ],
      );
    },
  );

  it.effect(
    "gates active plugins, panels, workers, MCP specs, and turn context on pluginsEnabled while keeping list intact",
    () => {
      const projectA = ProjectId.make("project-master-switch");
      return withPluginRegistry(
        {
          "full-plugin": {
            manifest: JSON.stringify({
              name: "full-plugin",
              displayName: "Full Plugin",
              css: "./plugin.css",
              panels: [{ id: "board", title: "Board", entry: "./board.html" }],
              worker: { entry: "./worker.mjs" },
            }),
            files: {
              "plugin.css": "body { --test-plugin: 1; }",
              "board.html": "<!doctype html><html><body>Board</body></html>",
              "worker.mjs": "export default function () {}",
              "AGENTS.md": "User plugin rule.",
              "skills/ping/SKILL.md": "---\ndescription: Ping command\n---\nPong!",
              ".mcp.json": JSON.stringify({
                docs: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/srv.mjs"] },
              }),
            },
          },
        },
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const settings = yield* ServerSettingsService;

          const initialList = yield* registry.list;
          const userPlugin = initialList.plugins.find((plugin) => plugin.id === "full-plugin");
          const repoPlugin = initialList.repoPlugins?.find((plugin) => plugin.id === "repo-cmd");
          assert.isDefined(userPlugin);
          assert.isDefined(repoPlugin);
          if (!userPlugin || !repoPlugin || repoPlugin.revision === undefined) {
            return assert.fail("Expected user and repo plugins to be discovered");
          }

          yield* registry.setEnabled("full-plugin", true, {
            approveWorker: true,
            approveExternal: true,
            revision: userPlugin.revision,
          });
          yield* registry.setEnabled("repo-cmd", true, {
            projectId: projectA,
            revision: repoPlugin.revision,
          });

          const activeQueue = yield* Queue.unbounded<ReadonlyArray<EnvironmentPlugin>>();
          const workerQueue =
            yield* Queue.unbounded<ReadonlyArray<PluginRegistry.PluginWorkerDesiredSpec>>();
          const mcpQueue =
            yield* Queue.unbounded<ReadonlyArray<PluginRegistry.PluginMcpServerDesiredSpec>>();
          yield* Stream.runForEach(registry.streamChanges, (value) =>
            Queue.offer(activeQueue, value),
          ).pipe(Effect.forkScoped);
          yield* Stream.runForEach(registry.streamWorkerDesiredState, (value) =>
            Queue.offer(workerQueue, value),
          ).pipe(Effect.forkScoped);
          yield* Stream.runForEach(registry.streamMcpDesiredState, (value) =>
            Queue.offer(mcpQueue, value),
          ).pipe(Effect.forkScoped);

          const initialActive = yield* Queue.take(activeQueue);
          const initialWorkers = yield* Queue.take(workerQueue);
          const initialMcp = yield* Queue.take(mcpQueue);
          assert.deepEqual(
            initialActive.map((plugin) => plugin.id),
            ["full-plugin", "repo-cmd"],
          );
          assert.strictEqual(initialWorkers.length, 1);
          assert.strictEqual(initialWorkers[0]?.runnable, true);
          assert.strictEqual(initialMcp.length, 1);
          assert.strictEqual(initialMcp[0]?.serverName, "docs");
          const resolvedBefore = yield* registry.resolvePanelEntry("full-plugin", "board");
          assert.isTrue(resolvedBefore.endsWith("board.html"));
          const turnBefore = yield* registry.getTurnContext(projectA);
          assert.strictEqual(turnBefore.commands.length, 2);
          assert.strictEqual(turnBefore.contextPlugins.length, 2);

          // Turn all plugins off: live streams clear, panels and turn context empty, list remains.
          yield* settings.updateSettings({ pluginsEnabled: false });
          assert.deepEqual(yield* Queue.take(activeQueue), []);
          assert.deepEqual(yield* Queue.take(workerQueue), []);
          assert.deepEqual(yield* Queue.take(mcpQueue), []);

          const panelOffErr = yield* registry
            .resolvePanelEntry("full-plugin", "board")
            .pipe(Effect.flip);
          assert.strictEqual(panelOffErr.reason, "not_found");
          const turnOff = yield* registry.getTurnContext(projectA);
          assert.deepEqual(turnOff, {
            contextPlugins: [],
            commands: [],
            hooks: {},
            agents: [],
          });

          const listWhileOff = yield* registry.list;
          assert.strictEqual(listWhileOff.plugins.length, 1);
          assert.strictEqual(listWhileOff.plugins[0]?.id, "full-plugin");
          assert.strictEqual(listWhileOff.repoPlugins?.length, 1);
          assert.strictEqual(listWhileOff.repoPlugins?.[0]?.id, "repo-cmd");

          // Turn plugins back on: everything active restores live.
          yield* settings.updateSettings({ pluginsEnabled: true });
          const restoredActive = yield* Queue.take(activeQueue);
          const restoredWorkers = yield* Queue.take(workerQueue);
          const restoredMcp = yield* Queue.take(mcpQueue);
          assert.deepEqual(
            restoredActive.map((plugin) => plugin.id),
            ["full-plugin", "repo-cmd"],
          );
          assert.strictEqual(restoredWorkers.length, 1);
          assert.strictEqual(restoredWorkers[0]?.runnable, true);
          assert.strictEqual(restoredMcp.length, 1);
          assert.strictEqual(restoredMcp[0]?.serverName, "docs");
          const resolvedAfter = yield* registry.resolvePanelEntry("full-plugin", "board");
          assert.isTrue(resolvedAfter.endsWith("board.html"));
          const turnAfter = yield* registry.getTurnContext(projectA);
          assert.strictEqual(turnAfter.commands.length, 2);
          assert.strictEqual(turnAfter.contextPlugins.length, 2);
        }),
        DEFAULT_SERVER_SETTINGS,
        [
          {
            projectId: projectA,
            title: "Project Master Switch",
            plugins: {
              "repo-cmd": {
                manifest: JSON.stringify({ name: "repo-cmd" }),
                files: {
                  "AGENTS.md": "Repo rule.",
                  "commands/deploy.md": "Run deploy.",
                },
              },
            },
          },
        ],
      );
    },
  );
});
