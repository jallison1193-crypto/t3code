import {
  DEFAULT_SERVER_SETTINGS,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  THEME_CSS_MAX_LENGTH,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
          assert.deepEqual(listed.plugins, [
            {
              id: "compact-sidebar",
              displayName: "Compact Sidebar",
              description: "Tightens sidebar rows.",
              version: "1.2.3",
              enabled: false,
              contributes: ["css"],
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
});
