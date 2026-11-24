// @effect-diagnostics nodeBuiltinImport:off - Windows command resolution inspects file extensions with node:path.
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { npmShimExecutable, SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { McpClient, McpProtocol, McpSchema } from "effect/ai";
import type { McpClientError } from "effect/ai/McpClientError";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PluginRegistry from "./PluginRegistry.ts";
import {
  buildPluginMcpProcessEnv,
  expandPluginMcpString,
  pluginMcpToolName,
} from "./pluginExternalConfig.ts";

const STARTUP_TIMEOUT = Duration.seconds(30);
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const RETRY_BACKOFFS = [Duration.seconds(1), Duration.seconds(5), Duration.seconds(30)] as const;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_PLUGIN_TOOLS_TOTAL = 128;
const MAX_ERROR_CHARS = 500;

export interface ProxiedPluginMcpTool {
  readonly name: string;
  readonly pluginId: string;
  readonly serverName: string;
  readonly upstreamName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface PluginMcpProxyEvent {
  readonly pluginId: string;
  readonly serverName: string;
  readonly type: "starting" | "running" | "retrying" | "failed" | "stopped";
  readonly toolCount?: number;
  readonly truncatedTools?: boolean;
  readonly attempt?: number;
  readonly error?: string;
}

export interface PluginMcpProxyOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly defaultCallTimeoutMs?: number;
  readonly retryBackoffs?: ReadonlyArray<Duration.Duration>;
  readonly maxToolsPerServer?: number;
  readonly maxToolsTotal?: number;
  readonly transportFactory?: (
    spec: PluginRegistry.PluginMcpServerDesiredSpec,
  ) => Effect.Effect<McpClient.Transport, McpClientError, Scope.Scope>;
}

export class PluginMcpProxy extends Context.Service<
  PluginMcpProxy,
  {
    readonly isToolActive: (toolName: string) => boolean;
    readonly listActiveTools: () => ReadonlyArray<ProxiedPluginMcpTool>;
    readonly callTool: (toolName: string, args: unknown) => Effect.Effect<McpSchema.CallToolResult>;
    readonly catalogChanges: Stream.Stream<ReadonlyArray<ProxiedPluginMcpTool>>;
    readonly events: Stream.Stream<PluginMcpProxyEvent>;
  }
>()("t3/plugins/PluginMcpProxy") {}

interface ActiveToolBinding {
  readonly tool: ProxiedPluginMcpTool;
  readonly upstreamTool: McpSchema.Tool;
  readonly client: McpClient.McpClient;
  readonly callTimeoutMs: number;
  readonly serverKey: string;
  readonly configKey: string;
}

interface RunningServer {
  readonly configKey: string;
  readonly spec: PluginRegistry.PluginMcpServerDesiredSpec;
  readonly scope: Scope.Closeable;
  readonly client: McpClient.McpClient;
  readonly tools: ReadonlyArray<{
    readonly proxied: ProxiedPluginMcpTool;
    readonly upstream: McpSchema.Tool;
  }>;
  readonly truncatedTools: boolean;
  readonly stop: Effect.Effect<void>;
}

interface ManagedMcpServer {
  readonly serverKey: string;
  readonly pluginId: string;
  readonly serverName: string;
  desired: PluginRegistry.PluginMcpServerDesiredSpec | null;
  active: RunningServer | null;
  retryFiber: Fiber.Fiber<void, never> | null;
  failureCount: number;
  failedConfigKey: string | null;
  lastError?: string;
  readonly opSemaphore: Semaphore.Semaphore;
}

const serverMapKey = (pluginId: string, serverName: string): string => `${pluginId}\0${serverName}`;

const sanitizeErrorText = (raw: string, fallback: string): string => {
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return fallback;
  return singleLine.length > MAX_ERROR_CHARS
    ? `${singleLine.slice(0, MAX_ERROR_CHARS - 1)}…`
    : singleLine;
};

const formatMcpClientError = (error: McpClientError): string => {
  const reason = error.reason;
  const message =
    typeof reason.message === "string" && reason.message.trim().length > 0
      ? reason.message
      : error.message;
  return sanitizeErrorText(message, "MCP server request failed.");
};

const windowsEnvValue = (env: Record<string, string>, name: string): string | undefined => {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
};

const escapeWindowsCmdToken = (token: string): string =>
  /\s/.test(token) ? token : token.replace(/[()&<>@^|]/g, "^$&");

const resolvePluginMcpStdioCommand = Effect.fn("PluginMcpProxy.resolveStdioCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32") {
    return { command, args: [...args] };
  }
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolved =
    (yield* Effect.promise(async () => resolveExecutable(command, "win32", env))) ?? command;
  const ext = NodePath.win32.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return { command: resolved, args: [...args] };
  }
  const nativeExe = npmShimExecutable(resolved);
  if (nativeExe !== undefined) {
    return { command: nativeExe, args: [...args] };
  }
  const systemRoot = windowsEnvValue(env, "SystemRoot");
  const comSpec =
    windowsEnvValue(env, "ComSpec") ??
    (systemRoot ? `${systemRoot}\\System32\\cmd.exe` : "cmd.exe");
  const cmdTarget = /\s/.test(resolved) ? ["@", resolved] : [escapeWindowsCmdToken(resolved)];
  return {
    command: comSpec,
    args: ["/d", "/c", ...cmdTarget, ...args.map(escapeWindowsCmdToken)],
  };
});

const normalizeInputSchema = (schema: unknown): Record<string, unknown> => {
  if (Predicate.isObject(schema) && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
};

const make = Effect.fn("PluginMcpProxy.make")(function* (options: PluginMcpProxyOptions = {}) {
  const pluginRegistry = yield* PluginRegistry.PluginRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const hostEnv = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const resolveExecutable = yield* SpawnExecutableResolution;

  const startupTimeout = options.startupTimeout ?? STARTUP_TIMEOUT;
  const defaultCallTimeoutMs = options.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const retryBackoffs = options.retryBackoffs ?? RETRY_BACKOFFS;
  const maxToolsPerServer = options.maxToolsPerServer ?? MAX_TOOLS_PER_SERVER;
  const maxToolsTotal = options.maxToolsTotal ?? MAX_PLUGIN_TOOLS_TOTAL;

  const proxyScope = yield* Scope.make("sequential");
  const reconcileSemaphore = yield* Semaphore.make(1);
  const shuttingDownRef = yield* Ref.make(false);
  const catalogPubSub = yield* PubSub.sliding<ReadonlyArray<ProxiedPluginMcpTool>>(1);
  const eventPubSub = yield* PubSub.unbounded<PluginMcpProxyEvent>();
  const managedByKey = new Map<string, ManagedMcpServer>();

  let activeToolMap = new Map<string, ActiveToolBinding>();
  let activeToolSnapshot: ReadonlyArray<ProxiedPluginMcpTool> = [];

  const getOrCreateManaged = (pluginId: string, serverName: string): ManagedMcpServer => {
    const key = serverMapKey(pluginId, serverName);
    let entry = managedByKey.get(key);
    if (entry === undefined) {
      entry = {
        serverKey: key,
        pluginId,
        serverName,
        desired: null,
        active: null,
        retryFiber: null,
        failureCount: 0,
        failedConfigKey: null,
        opSemaphore: Semaphore.makeUnsafe(1),
      };
      managedByKey.set(key, entry);
    }
    return entry;
  };

  const emitEvent = (event: PluginMcpProxyEvent) =>
    PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

  // Untraced: rebuilds the synchronous active tool map and broadcasts catalog updates.
  const rebuildToolCatalog = Effect.fnUntraced(function* () {
    const sortedEntries = [...managedByKey.values()]
      .filter(
        (entry): entry is ManagedMcpServer & { readonly active: RunningServer } =>
          entry.active !== null,
      )
      .sort((a, b) =>
        a.pluginId !== b.pluginId
          ? a.pluginId.localeCompare(b.pluginId)
          : a.serverName.localeCompare(b.serverName),
      );

    const nextMap = new Map<string, ActiveToolBinding>();
    const nextList: Array<ProxiedPluginMcpTool> = [];
    const runtimeUpdates: Array<{
      readonly pluginId: string;
      readonly serverName: string;
      readonly toolCount: number;
      readonly truncatedTools: boolean;
    }> = [];

    for (const entry of sortedEntries) {
      const active = entry.active;
      let exposedForServer = 0;
      let truncated = active.truncatedTools;
      for (const item of active.tools) {
        if (nextList.length >= maxToolsTotal) {
          truncated = true;
          break;
        }
        if (nextMap.has(item.proxied.name)) {
          continue;
        }
        nextMap.set(item.proxied.name, {
          tool: item.proxied,
          upstreamTool: item.upstream,
          client: active.client,
          callTimeoutMs: active.spec.timeoutMs ?? defaultCallTimeoutMs,
          serverKey: entry.serverKey,
          configKey: active.configKey,
        });
        nextList.push(item.proxied);
        exposedForServer += 1;
      }
      if (truncated) {
        yield* Effect.logWarning("Plugin MCP server tool list exceeded cap", {
          pluginId: entry.pluginId,
          serverName: entry.serverName,
          exposedForServer,
          maxToolsPerServer,
          maxToolsTotal,
        });
      }
      runtimeUpdates.push({
        pluginId: entry.pluginId,
        serverName: entry.serverName,
        toolCount: exposedForServer,
        truncatedTools: truncated,
      });
    }

    activeToolMap = nextMap;
    activeToolSnapshot = nextList;
    for (const update of runtimeUpdates) {
      yield* pluginRegistry.reportMcpRuntime(update.pluginId, update.serverName, {
        status: "running",
        toolCount: update.toolCount,
        ...(update.truncatedTools ? { truncatedTools: true } : {}),
      });
    }
    yield* PubSub.publish(catalogPubSub, nextList).pipe(Effect.asVoid);
  });

  // Untraced: called under entry.opSemaphore during reconcile/shutdown.
  const stopEntryUnlocked = Effect.fnUntraced(function* (
    entry: ManagedMcpServer,
    stopOptions: {
      readonly resetFailures: boolean;
      readonly clearRuntime?: boolean;
      readonly keepFailedStatus?: boolean;
    },
  ) {
    const hadRetry = entry.retryFiber !== null;
    if (entry.retryFiber !== null) {
      const fiber = entry.retryFiber;
      entry.retryFiber = null;
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
    const hadActive = entry.active !== null;
    const hadFailed = entry.failedConfigKey !== null;
    if (entry.active !== null) {
      const active = entry.active;
      entry.active = null;
      yield* active.stop.pipe(Effect.ignore);
    }
    if (stopOptions.resetFailures) {
      entry.failureCount = 0;
      entry.failedConfigKey = null;
      delete entry.lastError;
    }
    if (hadActive) {
      yield* rebuildToolCatalog();
    }
    if (stopOptions.clearRuntime) {
      yield* pluginRegistry.reportMcpRuntime(entry.pluginId, entry.serverName, null);
    } else if (!stopOptions.keepFailedStatus) {
      yield* pluginRegistry.reportMcpRuntime(entry.pluginId, entry.serverName, {
        status: "stopped",
      });
    }
    if (hadActive || hadRetry || hadFailed) {
      yield* emitEvent({
        pluginId: entry.pluginId,
        serverName: entry.serverName,
        type: "stopped",
      });
    }
  });

  const scheduleFailureRecovery = (
    entry: ManagedMcpServer,
    configKey: string,
    detail: string,
  ): Effect.Effect<void> =>
    entry.opSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(shuttingDownRef)) return;
        if (entry.desired === null || entry.desired.configKey !== configKey) return;

        if (entry.active !== null && entry.active.configKey === configKey) {
          const active = entry.active;
          entry.active = null;
          yield* active.stop.pipe(Effect.ignore);
          yield* rebuildToolCatalog();
        }

        const error = sanitizeErrorText(detail, "MCP server failed.");
        entry.lastError = error;
        entry.failureCount += 1;

        if (entry.failureCount > retryBackoffs.length) {
          entry.failedConfigKey = configKey;
          yield* pluginRegistry.reportMcpRuntime(entry.pluginId, entry.serverName, {
            status: "failed",
            error,
          });
          yield* emitEvent({
            pluginId: entry.pluginId,
            serverName: entry.serverName,
            type: "failed",
            attempt: entry.failureCount,
            error,
          });
          return;
        }

        const attempt = entry.failureCount;
        const backoff = retryBackoffs[attempt - 1] ?? Duration.seconds(30);
        yield* pluginRegistry.reportMcpRuntime(entry.pluginId, entry.serverName, {
          status: "starting",
          error,
        });
        yield* emitEvent({
          pluginId: entry.pluginId,
          serverName: entry.serverName,
          type: "retrying",
          attempt,
          error,
        });

        const retryFiber = yield* Effect.sleep(backoff).pipe(
          Effect.andThen(
            entry.opSemaphore.withPermits(1)(
              Effect.gen(function* () {
                entry.retryFiber = null;
                if (yield* Ref.get(shuttingDownRef)) return;
                if (
                  entry.desired === null ||
                  entry.desired.configKey !== configKey ||
                  entry.active !== null ||
                  entry.failedConfigKey === configKey
                ) {
                  return;
                }
                yield* launchServerUnlocked(entry, entry.desired);
              }),
            ),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(proxyScope),
        );
        entry.retryFiber = retryFiber;
      }),
    );

  // Untraced: called under entry.opSemaphore; start/connect operations carry their own spans.
  const launchServerUnlocked = Effect.fnUntraced(function* (
    entry: ManagedMcpServer,
    spec: PluginRegistry.PluginMcpServerDesiredSpec,
  ): Effect.fn.Return<void> {
    if (yield* Ref.get(shuttingDownRef)) return;
    yield* pluginRegistry.reportMcpRuntime(entry.pluginId, entry.serverName, {
      status: "starting",
    });
    yield* emitEvent({
      pluginId: entry.pluginId,
      serverName: entry.serverName,
      type: "starting",
    });

    const dirResult = yield* fs
      .makeDirectory(spec.pluginDataDir, { recursive: true })
      .pipe(Effect.result);
    if (Result.isFailure(dirResult)) {
      yield* scheduleFailureRecovery(
        entry,
        spec.configKey,
        "Could not create plugin data directory.",
      ).pipe(Effect.forkIn(proxyScope));
      return;
    }

    const serverScope = yield* Scope.make("sequential");
    let intentionalStop = false;
    const processExited = yield* Deferred.make<string>();

    const buildTransport = (): Effect.Effect<McpClient.Transport, McpClientError, Scope.Scope> => {
      if (options.transportFactory !== undefined) {
        return options.transportFactory(spec);
      }
      const expansionCtx = {
        pluginRoot: spec.pluginRootReal,
        pluginDataDir: spec.pluginDataDir,
        env: hostEnv,
      };
      if (spec.transport.kind === "stdio") {
        const stdioConfig = spec.transport;
        return Effect.gen(function* () {
          const rawCommand = expandPluginMcpString(stdioConfig.command, expansionCtx);
          const rawArgs = stdioConfig.args.map((arg) => expandPluginMcpString(arg, expansionCtx));
          const env = buildPluginMcpProcessEnv({
            hostEnv,
            pluginRoot: spec.pluginRootReal,
            pluginDataDir: spec.pluginDataDir,
            declaredEnv: stdioConfig.env,
          });
          const resolved = yield* resolvePluginMcpStdioCommand(rawCommand, rawArgs, env).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(SpawnExecutableResolution, resolveExecutable),
          );
          const command = ChildProcess.make(resolved.command, resolved.args, {
            cwd: spec.pluginRootReal,
            env,
            extendEnv: false,
            shell: false,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          const monitoredSpawner = ChildProcessSpawner.make((cmd) =>
            spawner.spawn(cmd).pipe(
              Effect.tap((handle) =>
                handle.exitCode.pipe(
                  Effect.map((code) => `MCP server process exited (${code}).`),
                  Effect.orElseSucceed(() => "MCP server process exited."),
                  Effect.flatMap((reason) => Deferred.succeed(processExited, reason)),
                  Effect.ignore,
                  Effect.forkIn(serverScope),
                ),
              ),
            ),
          );
          return yield* McpClient.stdio({
            command,
            protocol: McpProtocol.v2025_11_25,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, monitoredSpawner));
        });
      }

      const httpConfig = spec.transport;
      const expandedUrl = expandPluginMcpString(httpConfig.url, expansionCtx);
      const expandedHeaders: Record<string, string> = {};
      for (const [headerName, headerVal] of Object.entries(httpConfig.headers)) {
        expandedHeaders[headerName] = expandPluginMcpString(headerVal, expansionCtx);
      }
      return McpClient.http({
        url: expandedUrl,
        headers: expandedHeaders,
        protocol: McpProtocol.v2025_11_25,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    };

    const connectResult = yield* Scope.provide(
      Effect.gen(function* () {
        const transport = yield* buildTransport();
        const client = yield* McpClient.make({
          name: "t3-code-plugin-proxy",
          version: "1.0.0",
          timeout: startupTimeout,
          discoveryLimits: { maxPages: 20, maxItems: 2_000 },
        }).pipe(Effect.provideService(McpClient.Transport, transport));
        const discovered = yield* client.listTools({
          timeout: startupTimeout,
          limits: { maxPages: 20, maxItems: 2_000 },
        });
        return { client, discovered };
      }),
      serverScope,
    ).pipe(Effect.result);

    if (Result.isFailure(connectResult)) {
      intentionalStop = true;
      yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
      yield* scheduleFailureRecovery(
        entry,
        spec.configKey,
        formatMcpClientError(connectResult.failure),
      ).pipe(Effect.forkIn(proxyScope));
      return;
    }

    const { client, discovered } = connectResult.success;
    const truncatedTools = discovered.length > maxToolsPerServer;
    const capped = truncatedTools ? discovered.slice(0, maxToolsPerServer) : discovered;
    const displayLabel = spec.pluginDisplayName ?? spec.pluginId;
    const mappedTools = capped.map((upstream) => {
      const description = upstream.description?.trim()
        ? `[${displayLabel}] ${upstream.description.trim()}`
        : `[${displayLabel}]`;
      return {
        proxied: {
          name: pluginMcpToolName(spec.pluginId, spec.serverName, upstream.name),
          pluginId: spec.pluginId,
          serverName: spec.serverName,
          upstreamName: upstream.name,
          description,
          inputSchema: normalizeInputSchema(upstream.inputSchema),
        },
        upstream,
      };
    });

    const exitWatcher = yield* Deferred.await(processExited).pipe(
      Effect.flatMap((reason) =>
        intentionalStop ? Effect.void : scheduleFailureRecovery(entry, spec.configKey, reason),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(proxyScope),
    );

    const stopServer = Effect.gen(function* () {
      intentionalStop = true;
      yield* Fiber.interrupt(exitWatcher).pipe(Effect.ignore);
      yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
    });

    entry.active = {
      configKey: spec.configKey,
      spec,
      scope: serverScope,
      client,
      tools: mappedTools,
      truncatedTools,
      stop: stopServer,
    };
    entry.failureCount = 0;
    entry.failedConfigKey = null;
    delete entry.lastError;

    yield* rebuildToolCatalog();
    yield* emitEvent({
      pluginId: entry.pluginId,
      serverName: entry.serverName,
      type: "running",
      toolCount: mappedTools.length,
      truncatedTools,
    });
  });

  const reconcile = (specs: ReadonlyArray<PluginRegistry.PluginMcpServerDesiredSpec>) =>
    reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(shuttingDownRef)) return;
        const nextByKey = new Map(
          specs.map((spec) => [serverMapKey(spec.pluginId, spec.serverName), spec] as const),
        );

        for (const [key, entry] of Array.from(managedByKey.entries())) {
          if (!nextByKey.has(key)) {
            yield* entry.opSemaphore.withPermits(1)(
              Effect.gen(function* () {
                entry.desired = null;
                yield* stopEntryUnlocked(entry, { resetFailures: true, clearRuntime: true });
              }),
            );
            managedByKey.delete(key);
          }
        }

        for (const spec of specs) {
          const entry = getOrCreateManaged(spec.pluginId, spec.serverName);
          yield* entry.opSemaphore.withPermits(1)(
            Effect.gen(function* () {
              entry.desired = spec;
              if (entry.active !== null && entry.active.configKey === spec.configKey) {
                return;
              }
              if (entry.failedConfigKey === spec.configKey) {
                return;
              }
              if (
                entry.active !== null ||
                entry.retryFiber !== null ||
                entry.failedConfigKey !== null
              ) {
                yield* stopEntryUnlocked(entry, { resetFailures: true });
              }
              yield* launchServerUnlocked(entry, spec);
            }),
          );
        }
      }),
    );

  yield* Effect.addFinalizer(() =>
    Ref.set(shuttingDownRef, true).pipe(
      Effect.andThen(
        Effect.forEach(
          Array.from(managedByKey.values()),
          (entry) =>
            entry.opSemaphore.withPermits(1)(
              stopEntryUnlocked(entry, { resetFailures: false, keepFailedStatus: true }),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.ignore),
      ),
      Effect.andThen(Scope.close(proxyScope, Exit.void).pipe(Effect.ignore)),
    ),
  );

  yield* Stream.runForEach(pluginRegistry.streamMcpDesiredState, (specs) =>
    reconcile(specs).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(proxyScope), Effect.asVoid);

  const callTool: PluginMcpProxy["Service"]["callTool"] = Effect.fn("PluginMcpProxy.callTool")(
    function* (toolName, rawArgs) {
      const binding = activeToolMap.get(toolName);
      if (binding === undefined) {
        return new McpSchema.CallToolResult({
          isError: true,
          content: [{ type: "text", text: `Plugin MCP tool "${toolName}" is not active.` }],
        });
      }
      const normalizedArgs =
        Predicate.isObject(rawArgs) && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      const result = yield* binding.client
        .callTool(
          {
            tool: binding.upstreamTool,
            arguments: normalizedArgs,
          },
          { timeout: Duration.millis(binding.callTimeoutMs) },
        )
        .pipe(Effect.result);

      if (Result.isSuccess(result)) {
        return result.success;
      }

      const error = result.failure;
      const text = formatMcpClientError(error);
      if (error.reason._tag === "TransportError" || error.reason._tag === "ClosedError") {
        const entry = managedByKey.get(binding.serverKey);
        if (entry !== undefined) {
          yield* scheduleFailureRecovery(entry, binding.configKey, text).pipe(
            Effect.forkIn(proxyScope),
          );
        }
      }
      return new McpSchema.CallToolResult({
        isError: true,
        content: [{ type: "text", text }],
      });
    },
  );

  return PluginMcpProxy.of({
    isToolActive: (toolName) => activeToolMap.has(toolName),
    listActiveTools: () => activeToolSnapshot,
    callTool,
    get catalogChanges() {
      return Stream.unwrap(
        Effect.map(PubSub.subscribe(catalogPubSub), (subscription) =>
          Stream.concat(Stream.make(activeToolSnapshot), Stream.fromSubscription(subscription)),
        ),
      );
    },
    get events() {
      return Stream.unwrap(
        Effect.map(PubSub.subscribe(eventPubSub), (subscription) =>
          Stream.fromSubscription(subscription),
        ),
      );
    },
  });
});

export const layer = Layer.effect(PluginMcpProxy, make());

export const layerWithOptions = (options: PluginMcpProxyOptions) =>
  Layer.effect(PluginMcpProxy, make(options));
