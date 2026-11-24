import {
  DEFAULT_SERVER_SETTINGS,
  PLUGIN_STATE_MAX_BYTES,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
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
import * as PluginStateStore from "./PluginStateStore.ts";

const withPluginStateStore = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | PluginStateStore.PluginStateStore
    | PluginRegistry.PluginRegistry
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
  initialSettings: ServerSettings = DEFAULT_SERVER_SETTINGS,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-state-" });
    const settingsRef = yield* Ref.make(initialSettings);
    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)),
      streamChanges: Stream.empty,
    });
    const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
    const registryLayer = PluginRegistry.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(settingsLayer),
    );
    const storeLayer = PluginStateStore.layer.pipe(Layer.provideMerge(registryLayer));
    return yield* body.pipe(Effect.provide(storeLayer));
  }).pipe(Effect.provide(NodeServices.layer));

describe("PluginStateStore", () => {
  it.effect("round-trips state for global and project scopes", () =>
    withPluginStateStore(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const store = yield* PluginStateStore.PluginStateStore;
        const projectA = ProjectId.make("project-alpha");
        const projectB = ProjectId.make("project-beta");

        yield* registry.write({
          id: "pomodoro",
          panels: [{ id: "timer", title: "Timer", html: "<html><body>ok</body></html>" }],
        });

        assert.isNull(yield* store.get("pomodoro", "global"));
        assert.isNull(yield* store.get("pomodoro", { projectId: projectA }));

        const globalValue = { presetMinutes: 25, sound: true };
        const projectValue = { endsAt: 1_700_000_000_000, task: "Write tests" };
        yield* store.set("pomodoro", "global", globalValue);
        yield* store.set("pomodoro", { projectId: projectA }, projectValue);

        assert.deepEqual(yield* store.get("pomodoro", "global"), globalValue);
        assert.deepEqual(yield* store.get("pomodoro", { projectId: projectA }), projectValue);
        assert.isNull(yield* store.get("pomodoro", { projectId: projectB }));
      }),
    ),
  );

  it.effect(
    "rejects payloads over 64 KB with state_too_large and unknown plugins with not_found",
    () =>
      withPluginStateStore(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const store = yield* PluginStateStore.PluginStateStore;

          const missing = yield* store.set("ghost", "global", { ok: true }).pipe(Effect.flip);
          assert.strictEqual(missing._tag, "PluginStateError");
          assert.strictEqual(missing.reason, "not_found");

          yield* registry.write({
            id: "checklist",
            panels: [{ id: "main", title: "Checklist", html: "<html><body>ok</body></html>" }],
          });

          const tooLarge = yield* store
            .set("checklist", "global", { text: "a".repeat(PLUGIN_STATE_MAX_BYTES) })
            .pipe(Effect.flip);
          assert.strictEqual(tooLarge._tag, "PluginStateError");
          assert.strictEqual(tooLarge.reason, "state_too_large");
          assert.isNull(yield* store.get("checklist", "global"));
        }),
      ),
  );

  it.effect("streamChanges emits current value first, then matching scope updates only", () =>
    withPluginStateStore(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const store = yield* PluginStateStore.PluginStateStore;
        const projectId = ProjectId.make("project-1");

        yield* registry.write({
          id: "pomodoro",
          panels: [{ id: "timer", title: "Timer", html: "<html><body>ok</body></html>" }],
        });
        yield* store.set("pomodoro", "global", { step: 1 });

        const seen = yield* Queue.unbounded<unknown>();
        yield* Stream.runForEach(store.streamChanges("pomodoro", "global"), (value) =>
          Queue.offer(seen, value),
        ).pipe(Effect.forkScoped);

        assert.deepEqual(yield* Queue.take(seen), { step: 1 });

        yield* store.set("pomodoro", { projectId }, { unrelated: true });
        yield* store.set("pomodoro", "global", { step: 2 });
        assert.deepEqual(yield* Queue.take(seen), { step: 2 });
      }),
    ),
  );

  it.effect("keeps saved state across plugin uninstall and restore", () =>
    withPluginStateStore(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const store = yield* PluginStateStore.PluginStateStore;
        const projectId = ProjectId.make("project-keep");

        const created = yield* registry.write({
          id: "sticky-notes",
          panels: [{ id: "notes", title: "Notes", html: "<html><body>notes</body></html>" }],
        });
        yield* store.set("sticky-notes", "global", { count: 3 });
        yield* store.set("sticky-notes", { projectId }, { items: ["remember milk"] });

        yield* registry.uninstall("sticky-notes");
        assert.deepEqual(yield* store.get("sticky-notes", "global"), { count: 3 });
        assert.deepEqual(yield* store.get("sticky-notes", { projectId }), {
          items: ["remember milk"],
        });

        yield* registry.restore("sticky-notes", created.after, true);
        assert.deepEqual(yield* store.get("sticky-notes", "global"), { count: 3 });
        assert.deepEqual(yield* store.get("sticky-notes", { projectId }), {
          items: ["remember milk"],
        });
      }),
    ),
  );
});
