import {
  IsoDateTime,
  PluginId,
  PluginOperationError,
  ProjectId,
  type InstalledPlugin,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectMemoryStore from "../projectMemory/ProjectMemoryStore.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import * as PluginStateStore from "./PluginStateStore.ts";
import { PLUGIN_WORKER_BOOTSTRAP_SOURCE } from "./PluginWorkerBootstrap.ts";
import {
  buildWorkerProcessArgs,
  buildWorkerProcessEnv,
  detectPluginWorkerRuntimeCapabilities,
  PLUGIN_WORKER_READ_MEMORY_MAX_FILE_BYTES,
  PLUGIN_WORKER_READ_MEMORY_MAX_FILES,
  PLUGIN_WORKER_READ_MEMORY_MAX_TOTAL_BYTES,
  PLUGIN_WORKER_UNSUPPORTED_PROBLEM,
  PluginWorkerLogBuffer,
  truncateUtf8,
} from "./pluginWorkerUtils.ts";

const WORKER_HELLO_TIMEOUT = Duration.seconds(15);
const WORKER_INIT_TIMEOUT = Duration.seconds(15);
const WORKER_RUN_TIMEOUT = Duration.minutes(5);
const WORKER_EXIT_TIMEOUT = Duration.seconds(2);
const WORKER_DEFAULT_BASE_BACKOFF = Duration.seconds(1);
const WORKER_MAX_CRASH_RESTARTS = 3;
const WORKER_MAX_STDOUT_LINE_BYTES = 512 * 1024;
const WORKER_MAX_ERROR_CHARS = 500;
const WORKER_STDERR_TAIL_CHARS = 4_096;

const isPluginId = Schema.is(PluginId);

class WorkerRpcError extends Schema.TaggedError<WorkerRpcError>()("WorkerRpcError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeUnknownEffect(JsonUnknown);
const encodeJsonLine = Schema.encodeUnknownEffect(JsonUnknown);

export interface PluginWorkerSupervisorOptions {
  readonly baseBackoff?: Duration.Duration;
  readonly runTimeout?: Duration.Duration;
  readonly helloTimeout?: Duration.Duration;
  readonly bootstrapSource?: string;
  readonly runtimeCapabilitiesOverride?: {
    readonly permissionSupported: boolean;
    readonly networkRestricted: boolean;
    readonly isElectron?: boolean;
  };
}

export interface PluginWorkerSupervisorEvent {
  readonly pluginId: string;
  readonly type:
    | "started"
    | "stopped"
    | "run-completed"
    | "run-failed"
    | "run-skipped"
    | "restarting"
    | "crashed"
    | "unsupported";
  readonly reason?: "start" | "schedule" | "manual";
  readonly attempt?: number;
  readonly error?: string;
}

export class PluginWorkerSupervisor extends Context.Service<
  PluginWorkerSupervisor,
  {
    readonly runNow: (pluginId: string) => Effect.Effect<
      {
        readonly plugin: InstalledPlugin;
        readonly skipped: boolean;
      },
      PluginOperationError
    >;
    readonly getLog: (pluginId: string) => Effect.Effect<
      {
        readonly log: string;
        readonly truncated: boolean;
      },
      PluginOperationError
    >;
    readonly events: Stream.Stream<PluginWorkerSupervisorEvent>;
  }
>()("t3/plugins/PluginWorkerSupervisor") {}

interface WorkerHello {
  readonly hasPermission: boolean;
  readonly networkLockSupported: boolean;
  readonly networkBlocked: boolean;
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, WorkerRpcError>;
}

interface RunningWorker {
  readonly key: string;
  readonly spec: PluginRegistry.PluginWorkerDesiredSpec;
  readonly scope: Scope.Closeable;
  readonly run: (
    reason: "start" | "schedule" | "manual",
  ) => Effect.Effect<{ readonly skipped: boolean }, WorkerRpcError>;
  readonly stop: Effect.Effect<void>;
  readonly hasRunHandler: boolean;
}

interface ManagedPluginWorker {
  desired: PluginRegistry.PluginWorkerDesiredSpec | null;
  active: RunningWorker | null;
  retryFiber: Fiber.Fiber<void, never> | null;
  crashCount: number;
  crashedKey: string | null;
  lastRunAt?: IsoDateTime;
  lastError?: string;
  runtimeProblem?: string;
  networkRestricted: boolean;
  readonly logBuffer: PluginWorkerLogBuffer;
  readonly opSemaphore: Semaphore.Semaphore;
}

const sanitizeErrorText = (raw: string): string => {
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return "Worker exited unexpectedly.";
  return singleLine.length > WORKER_MAX_ERROR_CHARS
    ? `${singleLine.slice(0, WORKER_MAX_ERROR_CHARS - 1)}…`
    : singleLine;
};

const specKey = (spec: PluginRegistry.PluginWorkerDesiredSpec): string =>
  JSON.stringify({
    entryCanonicalPath: spec.entryCanonicalPath,
    workerCodeHash: spec.workerCodeHash,
    powersHash: spec.powersHash,
    everyMinutes: spec.everyMinutes ?? null,
    network: spec.network,
    folders: spec.folders.map((folder) => ({
      id: folder.id,
      access: folder.access,
      realPath: folder.realPath,
    })),
  });

const make = Effect.fn("PluginWorkerSupervisor.make")(function* (
  options: PluginWorkerSupervisorOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executablePath = yield* HostProcess.ExecutablePath;
  const hostEnv = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const pluginRegistry = yield* PluginRegistry.PluginRegistry;
  const pluginStateStore = yield* PluginStateStore.PluginStateStore;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projectMemoryStore = yield* ProjectMemoryStore.ProjectMemoryStore;

  const detectedCaps = detectPluginWorkerRuntimeCapabilities();
  const runtimeCaps = {
    permissionSupported:
      options.runtimeCapabilitiesOverride?.permissionSupported ?? detectedCaps.permissionSupported,
    networkRestricted:
      options.runtimeCapabilitiesOverride?.networkRestricted ?? detectedCaps.networkRestricted,
    isElectron: options.runtimeCapabilitiesOverride?.isElectron ?? detectedCaps.isElectron,
  };
  const baseBackoff = options.baseBackoff ?? WORKER_DEFAULT_BASE_BACKOFF;
  const runTimeout = options.runTimeout ?? WORKER_RUN_TIMEOUT;
  const helloTimeout = options.helloTimeout ?? WORKER_HELLO_TIMEOUT;
  const bootstrapSource = options.bootstrapSource ?? PLUGIN_WORKER_BOOTSTRAP_SOURCE;

  const supervisorScope = yield* Scope.make("sequential");
  const eventPubSub = yield* PubSub.unbounded<PluginWorkerSupervisorEvent>();
  const managedById = new Map<string, ManagedPluginWorker>();
  const reconcileSemaphore = yield* Semaphore.make(1);
  const shuttingDownRef = yield* Ref.make(false);

  const getOrCreateManaged = (pluginId: string): ManagedPluginWorker => {
    let entry = managedById.get(pluginId);
    if (entry === undefined) {
      entry = {
        desired: null,
        active: null,
        retryFiber: null,
        crashCount: 0,
        crashedKey: null,
        networkRestricted: runtimeCaps.networkRestricted,
        logBuffer: new PluginWorkerLogBuffer(),
        opSemaphore: Semaphore.makeUnsafe(1),
      };
      managedById.set(pluginId, entry);
    }
    return entry;
  };

  const emitEvent = (event: PluginWorkerSupervisorEvent) =>
    PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

  // Untraced: internal log formatting helper called from hot log/stderr streams.
  const appendLogLine = (entry: ManagedPluginWorker, level: string, text: string) =>
    DateTime.now.pipe(
      Effect.tap((now) =>
        Effect.sync(() => {
          const stamp = DateTime.formatIso(now);
          const trimmed = text.endsWith("\n") ? text : `${text}\n`;
          entry.logBuffer.append(`[${stamp}] [${level}] ${trimmed}`);
        }),
      ),
      Effect.asVoid,
    );

  // Untraced: internal helper syncing supervisor runtime state back into PluginRegistry.
  const publishRuntimeState = (
    pluginId: string,
    entry: ManagedPluginWorker,
    status: "running" | "stopped" | "crashed",
  ) =>
    pluginRegistry.reportWorkerRuntime(pluginId, {
      status,
      networkRestricted: entry.networkRestricted,
      ...(entry.lastRunAt !== undefined ? { lastRunAt: entry.lastRunAt } : {}),
      ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
      ...(entry.runtimeProblem !== undefined ? { runtimeProblem: entry.runtimeProblem } : {}),
    });

  // Untraced: called inside worker JSON-RPC host request dispatch.
  const handleWorkerHostRequest = Effect.fnUntraced(function* (
    pluginId: PluginId,
    method: string,
    params: unknown,
  ): Effect.fn.Return<unknown, WorkerRpcError> {
    switch (method) {
      case "state/get":
        return yield* pluginStateStore
          .get(pluginId, "global")
          .pipe(Effect.mapError((error) => new WorkerRpcError({ detail: error.message })));
      case "state/set": {
        const value =
          Predicate.isObject(params) && Object.hasOwn(params, "value") ? params.value : null;
        yield* pluginStateStore
          .set(pluginId, "global", value)
          .pipe(Effect.mapError((error) => new WorkerRpcError({ detail: error.message })));
        return { ok: true };
      }
      case "projects/list": {
        const projects = yield* projectStore
          .list()
          .pipe(Effect.mapError((error) => new WorkerRpcError({ detail: error.message })));
        return projects.map((project) => ({
          id: project.projectId,
          title: project.title,
        }));
      }
      case "projects/readMemory": {
        const rawProjectId =
          Predicate.isObject(params) && typeof params.projectId === "string"
            ? params.projectId.trim()
            : "";
        if (rawProjectId.length === 0) {
          return yield* new WorkerRpcError({ detail: "projectId must be a non-empty string." });
        }
        const projectId = ProjectId.make(rawProjectId);
        const projectOpt = yield* projectStore
          .get(projectId)
          .pipe(Effect.mapError((error) => new WorkerRpcError({ detail: error.message })));
        if (Option.isNone(projectOpt)) {
          return yield* new WorkerRpcError({ detail: `Project "${rawProjectId}" was not found.` });
        }
        const memoryResult = yield* projectMemoryStore
          .readMemory(projectId)
          .pipe(Effect.mapError((error) => new WorkerRpcError({ detail: error.message })));
        const memory = truncateUtf8(
          memoryResult.content,
          PLUGIN_WORKER_READ_MEMORY_MAX_TOTAL_BYTES,
        );
        let remainingBytes =
          PLUGIN_WORKER_READ_MEMORY_MAX_TOTAL_BYTES - Buffer.byteLength(memory, "utf8");
        const summaries = yield* projectMemoryStore
          .listKnowledge(projectId)
          .pipe(Effect.mapError((error) => new WorkerRpcError({ detail: error.message })));
        const files: Array<{ readonly name: string; readonly text: string }> = [];
        for (const summary of summaries.slice(0, PLUGIN_WORKER_READ_MEMORY_MAX_FILES)) {
          if (remainingBytes <= 0) break;
          const fileResult = yield* projectMemoryStore
            .readKnowledge(projectId, summary.name)
            .pipe(Effect.option);
          if (Option.isNone(fileResult)) continue;
          const maxForFile = Math.min(PLUGIN_WORKER_READ_MEMORY_MAX_FILE_BYTES, remainingBytes);
          const text = truncateUtf8(fileResult.value.content, maxForFile);
          const textBytes = Buffer.byteLength(text, "utf8");
          remainingBytes -= textBytes;
          files.push({ name: fileResult.value.name, text });
        }
        return { memory, files };
      }
      default:
        return yield* new WorkerRpcError({ detail: `Unknown host RPC method: ${method}` });
    }
  });

  const stopEntryUnlocked = Effect.fn("PluginWorkerSupervisor.stopEntry")(function* (
    pluginId: string,
    entry: ManagedPluginWorker,
    options?: { readonly resetCrash?: boolean; readonly clearRuntime?: boolean },
  ) {
    if (entry.retryFiber !== null) {
      const retry = entry.retryFiber;
      entry.retryFiber = null;
      yield* Fiber.interrupt(retry).pipe(Effect.ignore);
    }
    const running = entry.active;
    entry.active = null;
    if (running !== null) {
      yield* running.stop.pipe(Effect.ignore);
    }
    if (options?.resetCrash === true) {
      entry.crashCount = 0;
      entry.crashedKey = null;
      delete entry.lastError;
    }
    if (options?.clearRuntime === true) {
      delete entry.runtimeProblem;
      yield* pluginRegistry.reportWorkerRuntime(pluginId, null);
    } else if (running !== null || options?.resetCrash === true) {
      yield* publishRuntimeState(pluginId, entry, "stopped");
    }
    if (running !== null) {
      yield* emitEvent({ pluginId, type: "stopped" });
    }
  });

  const handleUnexpectedExit = Effect.fn("PluginWorkerSupervisor.handleUnexpectedExit")(function* (
    pluginId: string,
    entry: ManagedPluginWorker,
    failedKey: string,
    reason: string,
  ): Effect.fn.Return<void> {
    if (yield* Ref.get(shuttingDownRef)) return;
    const shouldScheduleRetry = yield* entry.opSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(shuttingDownRef)) return null;
        if (
          entry.desired === null ||
          !entry.desired.runnable ||
          specKey(entry.desired) !== failedKey
        ) {
          return null;
        }
        if (entry.active !== null && entry.active.key === failedKey) {
          const dead = entry.active;
          entry.active = null;
          yield* dead.stop.pipe(Effect.ignore);
        }
        const cleanError = sanitizeErrorText(reason);
        entry.lastError = cleanError;
        entry.crashCount += 1;
        yield* appendLogLine(
          entry,
          "error",
          `Worker exited unexpectedly (attempt ${entry.crashCount}): ${cleanError}`,
        );

        if (entry.crashCount > WORKER_MAX_CRASH_RESTARTS) {
          entry.crashedKey = failedKey;
          yield* publishRuntimeState(pluginId, entry, "crashed");
          yield* emitEvent({
            pluginId,
            type: "crashed",
            attempt: entry.crashCount,
            error: cleanError,
          });
          return null;
        }

        yield* publishRuntimeState(pluginId, entry, "stopped");
        yield* emitEvent({
          pluginId,
          type: "restarting",
          attempt: entry.crashCount,
          error: cleanError,
        });
        const delayMs = Duration.toMillis(baseBackoff) * 2 ** (entry.crashCount - 1);
        return { delayMs, spec: entry.desired };
      }),
    );

    if (shouldScheduleRetry === null) return;

    const retryFiber = yield* Effect.gen(function* () {
      if (shouldScheduleRetry.delayMs > 0) {
        yield* Effect.sleep(Duration.millis(shouldScheduleRetry.delayMs));
      }
      yield* entry.opSemaphore.withPermits(1)(
        Effect.gen(function* () {
          entry.retryFiber = null;
          if (yield* Ref.get(shuttingDownRef)) return;
          if (
            entry.desired === null ||
            !entry.desired.runnable ||
            specKey(entry.desired) !== failedKey ||
            entry.active !== null ||
            entry.crashedKey === failedKey
          ) {
            return;
          }
          yield* launchWorkerUnlocked(pluginId, entry, entry.desired);
        }),
      );
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(supervisorScope));

    entry.retryFiber = retryFiber;
  });

  const launchWorkerUnlocked = Effect.fn("PluginWorkerSupervisor.launchWorker")(function* (
    pluginId: string,
    entry: ManagedPluginWorker,
    spec: PluginRegistry.PluginWorkerDesiredSpec,
  ): Effect.fn.Return<void> {
    const key = specKey(spec);
    if (!runtimeCaps.permissionSupported) {
      entry.runtimeProblem = PLUGIN_WORKER_UNSUPPORTED_PROBLEM;
      yield* appendLogLine(entry, "error", PLUGIN_WORKER_UNSUPPORTED_PROBLEM);
      yield* publishRuntimeState(pluginId, entry, "stopped");
      yield* emitEvent({
        pluginId,
        type: "unsupported",
        error: PLUGIN_WORKER_UNSUPPORTED_PROBLEM,
      });
      return;
    }

    const grantedFolders: Record<string, string> = {};
    const folderGrants: Array<{ readonly access: "read" | "write"; readonly realPath: string }> =
      [];
    for (const folder of spec.folders) {
      if (folder.realPath === null) {
        return;
      }
      grantedFolders[folder.id] = folder.realPath;
      folderGrants.push({ access: folder.access, realPath: folder.realPath });
    }

    const workerScope = yield* Scope.make("sequential");
    const args = buildWorkerProcessArgs({
      pluginRootReal: spec.pluginRootReal,
      folders: folderGrants,
      network: spec.network,
      allowNetFlagSupported: runtimeCaps.networkRestricted,
      bootstrapSource,
    });
    const env = buildWorkerProcessEnv(hostEnv, platform, runtimeCaps.isElectron);

    const spawned = yield* Scope.provide(
      Effect.acquireRelease(
        spawner.spawn(
          ChildProcess.make(executablePath, args, {
            stdin: { stream: "pipe", endOnDone: false },
            stdout: "pipe",
            stderr: "pipe",
            env,
            extendEnv: false,
            killSignal: "SIGTERM",
            forceKillAfter: WORKER_EXIT_TIMEOUT,
          }),
        ),
        (child) => child.kill().pipe(Effect.ignore),
      ),
      workerScope,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new WorkerRpcError({
            detail:
              cause instanceof Error ? cause.message : String(cause ?? "Failed to spawn worker."),
            cause,
          }),
      ),
      Effect.result,
    );

    if (Result.isFailure(spawned)) {
      yield* Scope.close(workerScope, Exit.void).pipe(Effect.ignore);
      yield* handleUnexpectedExit(pluginId, entry, key, spawned.failure.message).pipe(
        Effect.forkIn(supervisorScope),
      );
      return;
    }

    const handle = spawned.success;
    const writeMutex = yield* Semaphore.make(1);
    const pendingRequests = new Map<number, PendingRequest>();
    const helloDeferred = yield* Deferred.make<WorkerHello, WorkerRpcError>();
    const stdoutDone = yield* Deferred.make<void>();
    const stderrDone = yield* Deferred.make<void>();
    const runInFlightRef = yield* Ref.make(false);

    let nextReqId = 1;
    let intentionalStop = false;
    let terminated = false;
    let stderrTail = "";

    const writeJsonLine = (payload: unknown): Effect.Effect<void, WorkerRpcError> =>
      writeMutex.withPermits(1)(
        Effect.suspend(() => {
          if (terminated || intentionalStop) {
            return Effect.fail(
              new WorkerRpcError({ detail: "Worker process is no longer running." }),
            );
          }
          return encodeJsonLine(payload).pipe(
            Effect.mapError(
              (cause) =>
                new WorkerRpcError({
                  detail: "Failed to encode worker RPC frame.",
                  cause,
                }),
            ),
            Effect.flatMap((encoded) =>
              Stream.run(Stream.encodeText(Stream.make(`${encoded}\n`)), handle.stdin).pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkerRpcError({
                      detail:
                        cause instanceof Error
                          ? cause.message
                          : String(cause ?? "stdin write failed"),
                      cause,
                    }),
                ),
              ),
            ),
          );
        }),
      );

    // Untraced: internal shutdown/exit cleanup helper; callers own the span.
    const failAllPending = Effect.fnUntraced(function* (reason: string) {
      const error = new WorkerRpcError({ detail: reason });
      yield* Deferred.fail(helloDeferred, error).pipe(Effect.ignore);
      const pending = Array.from(pendingRequests.values());
      pendingRequests.clear();
      for (const req of pending) {
        yield* Deferred.fail(req.deferred, error).pipe(Effect.ignore);
      }
    });

    const sendHostRequest = Effect.fn("PluginWorkerSupervisor.sendHostRequest")(function* (
      method: string,
      params: unknown,
      timeout: Duration.Duration,
    ): Effect.fn.Return<unknown, WorkerRpcError> {
      const id = nextReqId++;
      const deferred = yield* Deferred.make<unknown, WorkerRpcError>();
      pendingRequests.set(id, { deferred });
      const sent = yield* writeJsonLine({ jsonrpc: "2.0", id, method, params }).pipe(Effect.result);
      if (Result.isFailure(sent)) {
        pendingRequests.delete(id);
        return yield* sent.failure;
      }
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.suspend(() => {
              pendingRequests.delete(id);
              return Effect.fail(
                new WorkerRpcError({
                  detail: `Worker request "${method}" timed out after ${Duration.format(timeout)}.`,
                }),
              );
            }),
        }),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            pendingRequests.delete(id);
          }),
        ),
      );
    });

    // Untraced: hot-path NDJSON frame parser for worker stdout.
    const handleStdoutLine = Effect.fnUntraced(function* (line: string): Effect.fn.Return<void> {
      if (line.length === 0) return;
      if (Buffer.byteLength(line, "utf8") > WORKER_MAX_STDOUT_LINE_BYTES) {
        yield* appendLogLine(entry, "warn", "Dropped oversized worker stdout frame.");
        return;
      }
      const parsedOpt = yield* decodeJsonLine(line).pipe(Effect.option);
      if (Option.isNone(parsedOpt)) {
        yield* appendLogLine(entry, "stdout", line);
        return;
      }
      const parsed = parsedOpt.value;
      if (!Predicate.isObject(parsed) || parsed.jsonrpc !== "2.0") {
        yield* appendLogLine(entry, "stdout", line);
        return;
      }

      if (parsed.method === undefined && typeof parsed.id === "number") {
        const pending = pendingRequests.get(parsed.id);
        if (pending === undefined) return;
        pendingRequests.delete(parsed.id);
        if (Predicate.isObject(parsed.error)) {
          const msg =
            typeof parsed.error.message === "string" ? parsed.error.message : "Worker RPC failed.";
          yield* Deferred.fail(pending.deferred, new WorkerRpcError({ detail: msg })).pipe(
            Effect.ignore,
          );
        } else {
          yield* Deferred.succeed(pending.deferred, parsed.result).pipe(Effect.ignore);
        }
        return;
      }

      if (parsed.method === "worker/hello" && Predicate.isObject(parsed.params)) {
        const hasPermission = parsed.params.hasPermission === true;
        const networkLockSupported = parsed.params.networkLockSupported === true;
        const networkBlocked = parsed.params.networkBlocked === true;
        yield* Deferred.succeed(helloDeferred, {
          hasPermission,
          networkLockSupported,
          networkBlocked,
        }).pipe(Effect.ignore);
        return;
      }

      if (parsed.method === "worker/log" && Predicate.isObject(parsed.params)) {
        const level = typeof parsed.params.level === "string" ? parsed.params.level : "info";
        const text = typeof parsed.params.text === "string" ? parsed.params.text : "";
        yield* appendLogLine(entry, level, text);
        return;
      }

      if (typeof parsed.method === "string" && parsed.id !== undefined) {
        const requestId = parsed.id;
        const method = parsed.method;
        const params = parsed.params;
        yield* handleWorkerHostRequest(spec.pluginId, method, params).pipe(
          Effect.result,
          Effect.flatMap((result) =>
            Result.isSuccess(result)
              ? writeJsonLine({ jsonrpc: "2.0", id: requestId, result: result.success })
              : writeJsonLine({
                  jsonrpc: "2.0",
                  id: requestId,
                  error: { code: -32000, message: result.failure.message },
                }),
          ),
          Effect.ignore,
          Effect.forkIn(workerScope),
        );
      }
    });

    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          stderrTail += chunk;
          if (stderrTail.length > WORKER_STDERR_TAIL_CHARS) {
            stderrTail = stderrTail.slice(-WORKER_STDERR_TAIL_CHARS);
          }
          for (const line of chunk.split(/\r?\n/)) {
            if (line.length > 0) {
              yield* appendLogLine(entry, "stderr", line);
            }
          }
        }),
      ),
      Effect.ignore,
      Effect.ensuring(Deferred.succeed(stderrDone, undefined).pipe(Effect.asVoid)),
      Effect.forkIn(workerScope),
    );

    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(handleStdoutLine),
      Effect.ignore,
      Effect.ensuring(Deferred.succeed(stdoutDone, undefined).pipe(Effect.asVoid)),
      Effect.forkIn(workerScope),
    );

    const stopWorker = Effect.gen(function* () {
      if (intentionalStop) return;
      intentionalStop = true;
      terminated = true;
      yield* failAllPending("Worker stopped.");
      yield* Scope.close(workerScope, Exit.void).pipe(Effect.ignore);
    });

    const exitWatcher = yield* handle.exitCode.pipe(
      Effect.map((code) => Number(code)),
      Effect.orElseSucceed(() => undefined),
      Effect.flatMap((exitCode) =>
        Effect.all([Deferred.await(stdoutDone), Deferred.await(stderrDone)], {
          concurrency: "unbounded",
          discard: true,
        }).pipe(
          Effect.timeoutOption(Duration.millis(500)),
          Effect.andThen(
            Effect.gen(function* () {
              terminated = true;
              const detail =
                stderrTail.trim().length > 0
                  ? stderrTail.trim()
                  : `Worker exited with code ${exitCode ?? "unknown"}.`;
              yield* failAllPending(detail);
              if (!intentionalStop) {
                yield* handleUnexpectedExit(pluginId, entry, key, detail).pipe(
                  Effect.forkIn(supervisorScope),
                );
              }
            }),
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(supervisorScope),
    );

    const cleanupAndStop = Effect.gen(function* () {
      yield* stopWorker;
      yield* Fiber.interrupt(exitWatcher).pipe(Effect.ignore);
    });

    const helloResult = yield* Deferred.await(helloDeferred).pipe(
      Effect.timeoutOrElse({
        duration: helloTimeout,
        orElse: () =>
          Effect.fail(new WorkerRpcError({ detail: "Worker failed to start in time." })),
      }),
      Effect.result,
    );

    if (Result.isFailure(helloResult)) {
      yield* cleanupAndStop;
      const detail = helloResult.failure.message;
      if (
        /bad option:\s*--permission/i.test(stderrTail) ||
        /bad option:\s*--permission/i.test(detail)
      ) {
        entry.runtimeProblem = PLUGIN_WORKER_UNSUPPORTED_PROBLEM;
        yield* appendLogLine(entry, "error", PLUGIN_WORKER_UNSUPPORTED_PROBLEM);
        yield* publishRuntimeState(pluginId, entry, "stopped");
        yield* emitEvent({
          pluginId,
          type: "unsupported",
          error: PLUGIN_WORKER_UNSUPPORTED_PROBLEM,
        });
        return;
      }
      yield* handleUnexpectedExit(pluginId, entry, key, detail).pipe(
        Effect.forkIn(supervisorScope),
      );
      return;
    }

    const hello = helloResult.success;
    entry.networkRestricted = hello.networkLockSupported;
    if (!hello.hasPermission) {
      yield* cleanupAndStop;
      entry.runtimeProblem = PLUGIN_WORKER_UNSUPPORTED_PROBLEM;
      yield* appendLogLine(entry, "error", PLUGIN_WORKER_UNSUPPORTED_PROBLEM);
      yield* publishRuntimeState(pluginId, entry, "stopped");
      yield* emitEvent({
        pluginId,
        type: "unsupported",
        error: PLUGIN_WORKER_UNSUPPORTED_PROBLEM,
      });
      return;
    }

    delete entry.runtimeProblem;

    const initResult = yield* sendHostRequest(
      "host/init",
      { entryPath: spec.entryCanonicalPath, folders: grantedFolders },
      WORKER_INIT_TIMEOUT,
    ).pipe(Effect.result);

    if (Result.isFailure(initResult)) {
      yield* cleanupAndStop;
      yield* handleUnexpectedExit(pluginId, entry, key, initResult.failure.message).pipe(
        Effect.forkIn(supervisorScope),
      );
      return;
    }

    const hasRunHandler =
      Predicate.isObject(initResult.success) && initResult.success.hasRunHandler === true;

    const run = Effect.fn("PluginWorkerSupervisor.run")(function* (
      reason: "start" | "schedule" | "manual",
    ): Effect.fn.Return<{ readonly skipped: boolean }, WorkerRpcError> {
      const acquired = yield* Ref.modify(runInFlightRef, (inFlight) =>
        inFlight ? ([false, true] as const) : ([true, true] as const),
      );
      if (!acquired) {
        yield* emitEvent({ pluginId, type: "run-skipped", reason });
        return { skipped: true };
      }
      return yield* Effect.gen(function* () {
        const response = yield* sendHostRequest("host/run", { reason }, runTimeout).pipe(
          Effect.result,
        );
        if (Result.isFailure(response)) {
          const message = sanitizeErrorText(response.failure.message);
          entry.lastError = message;
          yield* appendLogLine(entry, "error", `onRun(${reason}) failed: ${message}`);
          yield* publishRuntimeState(pluginId, entry, "running");
          yield* emitEvent({ pluginId, type: "run-failed", reason, error: message });
          if (/timed out/i.test(message)) {
            yield* handleUnexpectedExit(pluginId, entry, key, message).pipe(
              Effect.forkIn(supervisorScope),
            );
          }
          return yield* response.failure;
        }
        const skipped = Predicate.isObject(response.success) && response.success.skipped === true;
        if (!skipped) {
          const now = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
          entry.lastRunAt = now;
          delete entry.lastError;
          yield* publishRuntimeState(pluginId, entry, "running");
        }
        yield* emitEvent({
          pluginId,
          type: skipped ? "run-skipped" : "run-completed",
          reason,
        });
        return { skipped };
      }).pipe(Effect.ensuring(Ref.set(runInFlightRef, false)));
    });

    const runningWorker: RunningWorker = {
      key,
      spec,
      scope: workerScope,
      run,
      stop: cleanupAndStop,
      hasRunHandler,
    };
    entry.active = runningWorker;
    delete entry.lastError;
    yield* publishRuntimeState(pluginId, entry, "running");
    yield* emitEvent({ pluginId, type: "started" });

    if (hasRunHandler) {
      yield* run("start").pipe(Effect.ignore, Effect.forkIn(workerScope));
      if (spec.everyMinutes !== undefined) {
        const interval = Duration.minutes(spec.everyMinutes);
        yield* Effect.sleep(interval).pipe(
          Effect.andThen(
            run("schedule").pipe(Effect.ignore, Effect.repeat(Schedule.spaced(interval))),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(workerScope),
        );
      }
    }
  });

  const reconcile = (specs: ReadonlyArray<PluginRegistry.PluginWorkerDesiredSpec>) =>
    reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(shuttingDownRef)) return;
        const nextById = new Map(specs.map((spec) => [spec.pluginId, spec] as const));

        for (const [pluginId, entry] of Array.from(managedById.entries())) {
          if (!nextById.has(pluginId)) {
            yield* entry.opSemaphore.withPermits(1)(
              Effect.gen(function* () {
                entry.desired = null;
                yield* stopEntryUnlocked(pluginId, entry, {
                  resetCrash: true,
                  clearRuntime: true,
                });
              }),
            );
            managedById.delete(pluginId);
          }
        }

        for (const spec of specs) {
          const entry = getOrCreateManaged(spec.pluginId);
          yield* entry.opSemaphore.withPermits(1)(
            Effect.gen(function* () {
              entry.desired = spec;
              if (!spec.runnable) {
                yield* stopEntryUnlocked(spec.pluginId, entry, {
                  resetCrash: !spec.enabled || entry.crashedKey !== specKey(spec),
                });
                return;
              }

              const nextKey = specKey(spec);
              if (entry.active !== null && entry.active.key === nextKey) {
                return;
              }
              if (entry.crashedKey === nextKey) {
                return;
              }
              if (entry.active !== null || entry.retryFiber !== null || entry.crashedKey !== null) {
                yield* stopEntryUnlocked(spec.pluginId, entry, { resetCrash: true });
              }
              yield* launchWorkerUnlocked(spec.pluginId, entry, spec);
            }),
          );
        }
      }),
    );

  yield* Effect.addFinalizer(() =>
    Ref.set(shuttingDownRef, true).pipe(
      Effect.andThen(
        Effect.forEach(
          Array.from(managedById.entries()),
          ([pluginId, entry]) =>
            entry.opSemaphore.withPermits(1)(
              stopEntryUnlocked(pluginId, entry, { resetCrash: false }),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.ignore),
      ),
      Effect.andThen(Scope.close(supervisorScope, Exit.void).pipe(Effect.ignore)),
    ),
  );

  yield* Stream.runForEach(pluginRegistry.streamWorkerDesiredState, (specs) =>
    reconcile(specs).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(supervisorScope), Effect.asVoid);

  const runNow: PluginWorkerSupervisor["Service"]["runNow"] = Effect.fn(
    "PluginWorkerSupervisor.runNow",
  )(function* (pluginId) {
    if (!isPluginId(pluginId)) {
      return yield* new PluginOperationError({
        pluginId,
        operation: "runWorker",
        reason: "invalid_id",
      });
    }
    const { plugins } = yield* pluginRegistry.list;
    const existing = plugins.find((candidate) => candidate.id === pluginId);
    if (existing === undefined || existing.worker === undefined) {
      return yield* new PluginOperationError({
        pluginId,
        operation: "runWorker",
        reason: "not_found",
      });
    }
    const entry = managedById.get(pluginId);
    const active = entry?.active ?? null;
    if (active === null) {
      return yield* new PluginOperationError({
        pluginId,
        operation: "runWorker",
        reason: "worker_not_running",
      });
    }
    const runResult = yield* active.run("manual").pipe(
      Effect.mapError(
        (cause) =>
          new PluginOperationError({
            pluginId,
            operation: "runWorker",
            reason: "worker_run_failed",
            cause,
          }),
      ),
    );
    const refreshed = yield* pluginRegistry.list;
    const updatedPlugin =
      refreshed.plugins.find((candidate) => candidate.id === pluginId) ?? existing;
    return { plugin: updatedPlugin, skipped: runResult.skipped };
  });

  const getLog: PluginWorkerSupervisor["Service"]["getLog"] = Effect.fn(
    "PluginWorkerSupervisor.getLog",
  )(function* (pluginId) {
    if (!isPluginId(pluginId)) {
      return yield* new PluginOperationError({
        pluginId,
        operation: "getWorkerLog",
        reason: "invalid_id",
      });
    }
    const { plugins } = yield* pluginRegistry.list;
    const existing = plugins.find((candidate) => candidate.id === pluginId);
    if (existing === undefined || existing.worker === undefined) {
      return yield* new PluginOperationError({
        pluginId,
        operation: "getWorkerLog",
        reason: "not_found",
      });
    }
    const entry = managedById.get(pluginId);
    return entry === undefined ? { log: "", truncated: false } : entry.logBuffer.read();
  });

  return PluginWorkerSupervisor.of({
    runNow,
    getLog,
    get events() {
      return Stream.unwrap(
        Effect.map(PubSub.subscribe(eventPubSub), (subscription) =>
          Stream.fromSubscription(subscription),
        ),
      );
    },
  });
});

export const layer = Layer.effect(PluginWorkerSupervisor, make());

export const layerWithOptions = (options: PluginWorkerSupervisorOptions) =>
  Layer.effect(PluginWorkerSupervisor, make(options));
