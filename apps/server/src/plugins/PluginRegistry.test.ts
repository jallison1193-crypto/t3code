import {
  DEFAULT_SERVER_SETTINGS,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  THEME_CSS_MAX_LENGTH,
  type EnvironmentPlugin,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

interface PluginFixture {
  readonly manifest?: string | null;
  readonly files?: Readonly<Record<string, string>>;
}

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
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-registry-" });
    const pluginsDir = path.join(baseDir, "userdata", "plugins");
    yield* fs.makeDirectory(pluginsDir, { recursive: true });

    for (const [folderName, fixture] of Object.entries(fixtures)) {
      const pluginRoot = path.join(pluginsDir, folderName);
      yield* fs.makeDirectory(pluginRoot, { recursive: true });
      if (fixture.manifest !== undefined && fixture.manifest !== null) {
        const manifestDir = path.join(pluginRoot, PLUGIN_MANIFEST_DIR);
        yield* fs.makeDirectory(manifestDir, { recursive: true });
        yield* fs.writeFileString(path.join(manifestDir, PLUGIN_MANIFEST_FILE), fixture.manifest);
      }
      for (const [relativePath, content] of Object.entries(fixture.files ?? {})) {
        const filePath = path.join(pluginRoot, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, content);
      }
    }

    const settingsRef = yield* Ref.make(initialSettings);
    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
      streamChanges: Stream.empty,
    });

    return yield* body.pipe(
      Effect.provide(
        PluginRegistry.layer.pipe(
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
            { id: "notes-panel", css: "", panels: [{ id: "notes", title: "Notes" }] },
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
            { id: "notes-panel", css: "", panels: [{ id: "board", title: "Board" }] },
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
            { id: "notes-panel", css: "", panels: [{ id: "notes", title: "Notes" }] },
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
          const approvedAfterFolder = yield* registry.approveWorker("vault-sync");
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
});
