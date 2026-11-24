import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectMemoryStore from "../projectMemory/ProjectMemoryStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import * as PluginStateStore from "./PluginStateStore.ts";
import * as PluginWorkerSupervisor from "./PluginWorkerSupervisor.ts";
import {
  detectPluginWorkerRuntimeCapabilities,
  PLUGIN_WORKER_UNSUPPORTED_PROBLEM,
} from "./pluginWorkerUtils.ts";

const runtimeSupportsPermission = detectPluginWorkerRuntimeCapabilities().permissionSupported;

const SavedStateSchema = Schema.Struct({
  reasons: Schema.Array(Schema.String),
  synced: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      fileCount: Schema.Number,
      firstFile: Schema.NullOr(Schema.String),
    }),
  ),
  outsideError: Schema.NullOr(Schema.String),
});
const decodeSavedState = Schema.decodeUnknownSync(SavedStateSchema);

const PROJECT_ID = ProjectId.make("project-demo");

const makeProjectRow = (workspaceRoot: string): ProjectStore.ProjectRow => ({
  projectId: PROJECT_ID,
  title: "Demo Project",
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
  createdAt: IsoDateTime.make("2026-11-24T00:00:00.000Z"),
  updatedAt: IsoDateTime.make("2026-11-24T00:00:00.000Z"),
  deletedAt: null,
});

const withSupervisor = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | PluginWorkerSupervisor.PluginWorkerSupervisor
    | PluginRegistry.PluginRegistry
    | PluginStateStore.PluginStateStore
    | ProjectMemoryStore.ProjectMemoryStore
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
  options: {
    readonly supervisorOptions?: PluginWorkerSupervisor.PluginWorkerSupervisorOptions;
    readonly initialSettings?: ServerSettings;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-worker-" });
    const settingsRef = yield* Ref.make(options.initialSettings ?? DEFAULT_SERVER_SETTINGS);
    const settingsPubSub = yield* PubSub.unbounded<ServerSettings>();

    const settingsLayer = Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)).pipe(
          Effect.tap((next) => PubSub.publish(settingsPubSub, next)),
        ),
      streamChanges: Stream.unwrap(
        Effect.map(PubSub.subscribe(settingsPubSub), (subscription) =>
          Stream.fromSubscription(subscription),
        ),
      ),
    });

    const projectRow = makeProjectRow(baseDir);
    const projectStoreLayer = Layer.mock(ProjectStore.ProjectStoreV2)({
      list: () => Effect.succeed([projectRow]),
      get: (id) => Effect.succeed(id === PROJECT_ID ? Option.some(projectRow) : Option.none()),
    });

    const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
    const memoryLayer = ProjectMemoryStore.layer.pipe(Layer.provideMerge(configLayer));
    const registryLayer = PluginRegistry.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(settingsLayer),
    );
    const stateLayer = PluginStateStore.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(registryLayer),
    );
    const supervisorLayer = PluginWorkerSupervisor.layerWithOptions({
      baseBackoff: Duration.zero,
      ...options.supervisorOptions,
    }).pipe(
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(stateLayer),
      Layer.provideMerge(memoryLayer),
      Layer.provideMerge(projectStoreLayer),
    );

    return yield* body.pipe(Effect.provide(supervisorLayer));
  }).pipe(Effect.provide(NodeServices.layer));

const takeEvent = (
  queue: Queue.Queue<PluginWorkerSupervisor.PluginWorkerSupervisorEvent>,
  predicate: (event: PluginWorkerSupervisor.PluginWorkerSupervisorEvent) => boolean,
): Effect.Effect<PluginWorkerSupervisor.PluginWorkerSupervisorEvent> =>
  Queue.take(queue).pipe(Effect.filterOrElse(predicate, () => takeEvent(queue, predicate)));

describe("PluginWorkerSupervisor", () => {
  it.live(
    "starts only when enabled, approved, and folders are set; runs manual sync with state, memory, logs, and FS seat belt; stops on disable",
    () =>
      withSupervisor(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const registry = yield* PluginRegistry.PluginRegistry;
          const stateStore = yield* PluginStateStore.PluginStateStore;
          const memoryStore = yield* ProjectMemoryStore.ProjectMemoryStore;
          const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;

          const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worker-out-" });
          const outsideDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worker-outside-" });
          const outsideProbeFile = path.join(outsideDir, "escape.txt");

          yield* memoryStore.writeMemory(PROJECT_ID, "# Demo Memory\nKeep notes in sync.\n");
          yield* memoryStore.addKnowledge(PROJECT_ID, "guide.md", "Knowledge body.");

          const eventQueue =
            yield* Queue.unbounded<PluginWorkerSupervisor.PluginWorkerSupervisorEvent>();
          yield* Stream.runForEach(supervisor.events, (event) =>
            Queue.offer(eventQueue, event),
          ).pipe(Effect.forkScoped);

          // Example vault-sync-style worker: syncs project memory into granted folder, probes
          // outside folder to verify the permission seat belt, saves state, and logs output.
          const workerCode = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default function (t3) {
  t3.onRun(async ({ reason }) => {
    const projects = await t3.projects.list();
    const synced = [];
    for (const project of projects) {
      const { memory, files } = await t3.projects.readMemory(project.id);
      await writeFile(join(t3.folders.out, project.id + ".md"), memory, "utf8");
      synced.push({ id: project.id, title: project.title, fileCount: files.length, firstFile: files[0]?.name ?? null });
    }
    let outsideError = null;
    try {
      await writeFile(${JSON.stringify(outsideProbeFile)}, "should fail", "utf8");
    } catch (error) {
      outsideError = error?.code ?? String(error);
    }
    const prev = (await t3.state.get()) ?? { reasons: [] };
    await t3.state.set({ reasons: [...prev.reasons, reason], synced, outsideError });
    t3.log("synced", reason, synced.length);
  });
}
`;

          yield* registry.write({
            id: "example-sync",
            displayName: "Example Sync",
            worker: {
              code: workerCode,
              everyMinutes: 15,
              folders: [{ id: "out", label: "Sync output", access: "write" }],
              network: false,
            },
          });

          // Disabled: not running.
          assert.strictEqual(
            (yield* supervisor.runNow("example-sync").pipe(Effect.flip)).reason,
            "worker_not_running",
          );

          // Enabled without approval: needs-approval, still not running.
          yield* registry.setEnabled("example-sync", true);
          let listed = yield* registry.list;
          assert.strictEqual(listed.plugins[0]?.worker?.status, "needs-approval");
          assert.strictEqual(
            (yield* supervisor.runNow("example-sync").pipe(Effect.flip)).reason,
            "worker_not_running",
          );

          // Approved without folder: needs-folder, still not running.
          yield* registry.approveWorker("example-sync");
          listed = yield* registry.list;
          assert.strictEqual(listed.plugins[0]?.worker?.status, "needs-folder");

          // Setting folder satisfies all conditions -> starts and runs "start".
          yield* registry.setWorkerFolder("example-sync", "out", outDir);
          yield* takeEvent(
            eventQueue,
            (event) =>
              event.pluginId === "example-sync" &&
              event.type === "run-completed" &&
              event.reason === "start",
          );

          listed = yield* registry.list;
          assert.strictEqual(listed.plugins[0]?.worker?.status, "running");
          assert.isDefined(listed.plugins[0]?.worker?.lastRunAt);

          // Manual run passes reason: "manual".
          const manual = yield* supervisor.runNow("example-sync");
          assert.strictEqual(manual.skipped, false);
          assert.strictEqual(manual.plugin.worker?.status, "running");

          // State round-trips through PluginStateStore and records both "start" and "manual".
          const savedState = decodeSavedState(yield* stateStore.get("example-sync", "global"));
          assert.deepEqual(savedState.reasons, ["start", "manual"]);
          assert.deepEqual(savedState.synced, [
            { id: PROJECT_ID, title: "Demo Project", fileCount: 1, firstFile: "guide.md" },
          ]);

          // Granted folder write succeeded.
          const writtenMemory = yield* fs.readFileString(path.join(outDir, `${PROJECT_ID}.md`));
          assert.strictEqual(writtenMemory, "# Demo Memory\nKeep notes in sync.\n");

          // Write outside the granted folder failed under Node's permission seat belt.
          if (runtimeSupportsPermission) {
            assert.strictEqual(savedState.outsideError, "ERR_ACCESS_DENIED");
            assert.isFalse(yield* fs.exists(outsideProbeFile));
          }

          // Logs captured t3.log lines.
          const logResult = yield* supervisor.getLog("example-sync");
          assert.match(logResult.log, /synced start 1/);
          assert.match(logResult.log, /synced manual 1/);

          // Disable stops the worker cleanly.
          yield* registry.setEnabled("example-sync", false);
          yield* takeEvent(
            eventQueue,
            (event) => event.pluginId === "example-sync" && event.type === "stopped",
          );
          assert.strictEqual(
            (yield* supervisor.runNow("example-sync").pipe(Effect.flip)).reason,
            "worker_not_running",
          );
        }),
      ),
  );

  it.live(
    "restarts a crashing worker up to 3 times with backoff, marks crashed, and resets count on off/on",
    () =>
      withSupervisor(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;

          const eventQueue =
            yield* Queue.unbounded<PluginWorkerSupervisor.PluginWorkerSupervisorEvent>();
          yield* Stream.runForEach(supervisor.events, (event) =>
            Queue.offer(eventQueue, event),
          ).pipe(Effect.forkScoped);

          yield* registry.write({
            id: "crashy",
            displayName: "Crashy",
            worker: {
              code: 'export default function () { throw new Error("boom on init"); }\n',
            },
          });
          yield* registry.setEnabled("crashy", true, { approveWorker: true });

          const attempts: Array<number> = [];
          for (let expected = 1; expected <= 3; expected += 1) {
            const event = yield* takeEvent(
              eventQueue,
              (candidate) => candidate.pluginId === "crashy" && candidate.type === "restarting",
            );
            attempts.push(event.attempt ?? -1);
          }
          assert.deepEqual(attempts, [1, 2, 3]);

          const crashedEvent = yield* takeEvent(
            eventQueue,
            (candidate) => candidate.pluginId === "crashy" && candidate.type === "crashed",
          );
          assert.match(crashedEvent.error ?? "", /boom on init/i);

          const listedCrashed = yield* registry.list;
          assert.strictEqual(listedCrashed.plugins[0]?.worker?.status, "crashed");
          assert.match(listedCrashed.plugins[0]?.worker?.lastError ?? "", /boom on init/i);

          // Turning off and back on resets the crash count and retries again.
          yield* registry.setEnabled("crashy", false);
          yield* registry.write({
            id: "crashy",
            displayName: "Crashy",
            worker: {
              code: "export default function (t3) { t3.onRun(async () => { t3.log('recovered'); }); }\n",
            },
          });
          yield* registry.setEnabled("crashy", true);

          yield* takeEvent(
            eventQueue,
            (candidate) =>
              candidate.pluginId === "crashy" &&
              candidate.type === "run-completed" &&
              candidate.reason === "start",
          );
          const listedRecovered = yield* registry.list;
          assert.strictEqual(listedRecovered.plugins[0]?.worker?.status, "running");
        }),
      ),
  );

  it.live(
    "refuses to run when the runtime lacks process.permission and sets the unsupported problem text",
    () =>
      withSupervisor(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;

          const eventQueue =
            yield* Queue.unbounded<PluginWorkerSupervisor.PluginWorkerSupervisorEvent>();
          yield* Stream.runForEach(supervisor.events, (event) =>
            Queue.offer(eventQueue, event),
          ).pipe(Effect.forkScoped);

          yield* registry.write({
            id: "locked-worker",
            displayName: "Locked Worker",
            worker: {
              code: "export default function () {}\n",
            },
          });
          yield* registry.setEnabled("locked-worker", true, { approveWorker: true });

          const unsupported = yield* takeEvent(
            eventQueue,
            (candidate) =>
              candidate.pluginId === "locked-worker" && candidate.type === "unsupported",
          );
          assert.strictEqual(unsupported.error, PLUGIN_WORKER_UNSUPPORTED_PROBLEM);

          const listed = yield* registry.list;
          assert.strictEqual(listed.plugins[0]?.problem, PLUGIN_WORKER_UNSUPPORTED_PROBLEM);
          assert.strictEqual(listed.plugins[0]?.worker?.status, "stopped");
        }),
        {
          supervisorOptions: {
            runtimeCapabilitiesOverride: {
              permissionSupported: false,
              networkRestricted: false,
            },
          },
        },
      ),
  );
});
