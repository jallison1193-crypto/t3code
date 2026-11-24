import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpClientError, McpSchema, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as PluginMcpProxy from "./PluginMcpProxy.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

const FIXTURE_SCRIPT = new URL("./fixtures/testMcpServer.mjs", import.meta.url);
const BASE_HOST_ENV: NodeJS.ProcessEnv = { ...process.env };
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const threadInvocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-mcp-proxy-test"),
  requestNamespace: "session-mcp-proxy-test",
  thread: {
    threadId: ThreadId.make("thread-mcp-proxy-test"),
    providerSessionId: "session-mcp-proxy-test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};

const readOnlyClientInvocation: McpInvocationContext.McpInvocationScope = {
  ...threadInvocation,
  thread: undefined,
  client: {
    sessionId: "client-ro",
    label: "Read-only client",
    access: "read-only",
  },
};

const mcpServerClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "proxy-test", version: "1.0.0" },
  protocolVersion: "2025-11-25",
  initializePayload: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "proxy-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const nextMatchingEvent = <E>(
  queue: Queue.Dequeue<PluginMcpProxy.PluginMcpProxyEvent, E>,
  predicate: (event: PluginMcpProxy.PluginMcpProxyEvent) => boolean,
): Effect.Effect<PluginMcpProxy.PluginMcpProxyEvent, E> =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) {
        return event;
      }
    }
  });

const withProxyHarness = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | PluginMcpProxy.PluginMcpProxy
    | PluginRegistry.PluginRegistry
    | ServerSettingsService
    | McpServer.McpServer
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
  options: {
    readonly proxyOptions?: PluginMcpProxy.PluginMcpProxyOptions;
    readonly initialSettings?: ServerSettings;
    readonly extraHostEnv?: Readonly<Record<string, string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-mcp-proxy-" });
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

    const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
    const registryLayer = PluginRegistry.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(settingsLayer),
    );
    const hostEnvLayer = Layer.succeed(HostProcess.Environment, {
      ...BASE_HOST_ENV,
      ...options.extraHostEnv,
    });
    const proxyLayer = PluginMcpProxy.layerWithOptions(options.proxyOptions ?? {}).pipe(
      Layer.provideMerge(registryLayer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(hostEnvLayer),
    );
    const mcpLayer = Layer.mergeAll(
      McpHttpServer.layerPluginMcpTools,
      McpHttpServer.layerToolSearch,
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(proxyLayer),
    );

    return yield* body.pipe(Effect.provide(mcpLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("PluginMcpProxy", () => {
  it.live(
    "starts an approved stdio plugin MCP server, proxies tools on /mcp and tool_search, isolates env, refuses read-only clients, returns isError on upstream errors, and removes tools on disable",
    () =>
      Effect.gen(function* () {
        const fixturePath = yield* Path.Path.pipe(
          Effect.flatMap((path) => path.fromFileUrl(FIXTURE_SCRIPT)),
          Effect.provide(NodeServices.layer),
        );

        yield* withProxyHarness(
          Effect.gen(function* () {
            const registry = yield* PluginRegistry.PluginRegistry;
            const proxy = yield* PluginMcpProxy.PluginMcpProxy;
            const server = yield* McpServer.McpServer;

            const eventQueue = yield* proxy.events.pipe(Stream.toQueue({ capacity: "unbounded" }));

            const written = yield* registry.write({
              id: "demo-mcp",
              displayName: "Demo MCP",
              mcpServers: {
                local: {
                  command: process.execPath,
                  args: [fixturePath],
                  env: {
                    PLUGIN_CUSTOM_VAR: "${HOST_CUSTOM_FOR_PLUGIN}",
                    PLUGIN_FALLBACK_VAR: "${UNSET_VAR_FOR_TEST:-default-val}",
                  },
                },
              },
            });

            // Enabling without approval does not start the server.
            yield* registry.setEnabled("demo-mcp", true);
            assert.deepEqual(proxy.listActiveTools(), []);

            // Approving starts the server and registers namespaced tools.
            yield* registry.setEnabled("demo-mcp", true, {
              approveExternal: true,
              revision: written.after,
            });
            const runningEvent = yield* nextMatchingEvent(
              eventQueue,
              (event) =>
                event.pluginId === "demo-mcp" &&
                event.serverName === "local" &&
                event.type === "running",
            );
            assert.strictEqual(runningEvent.toolCount, 3);

            const listed = yield* registry.list;
            const pluginEntry = listed.plugins.find((plugin) => plugin.id === "demo-mcp");
            assert.strictEqual(pluginEntry?.mcpServers?.[0]?.status, "running");
            assert.strictEqual(pluginEntry?.mcpServers?.[0]?.toolCount, 3);

            const echoToolName = "plugin_demo-mcp_local__echo";
            const envToolName = "plugin_demo-mcp_local__env_check";
            const failToolName = "plugin_demo-mcp_local__fail_tool";

            // Ensure layerPluginMcpTools has synced the tools onto McpServer.
            const syncedQueue = yield* proxy.catalogChanges.pipe(
              Stream.toQueue({ capacity: "unbounded" }),
            );
            const currentCatalog = yield* Queue.take(syncedQueue);
            assert.isTrue(currentCatalog.some((tool) => tool.name === echoToolName));

            const visibleNames = () =>
              Effect.sync(() =>
                server.tools
                  .filter(({ annotations }) => {
                    const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen);
                    return (
                      enabledWhen === undefined ||
                      enabledWhen({ protocolVersion: "", capabilities: {} })
                    );
                  })
                  .map(({ tool }) => tool.name),
              );

            const threadVisible = yield* visibleNames().pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
            );
            assert.include(threadVisible, echoToolName);
            const echoRegistered = server.tools.find(({ tool }) => tool.name === echoToolName);
            assert.match(echoRegistered?.tool.description ?? "", /^\[Demo MCP\]/);

            // Outside clients do not see plugin MCP tools.
            const outsideVisible = yield* visibleNames().pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                readOnlyClientInvocation,
              ),
            );
            assert.notInclude(outsideVisible, echoToolName);

            // tool_search discovers active plugin tools for deferring clients.
            const searchRes = yield* server
              .callTool({ name: "tool_search", arguments: { query: "Demo MCP echo" } })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
                Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
              );
            assert.notStrictEqual(searchRes.isError, true);
            const searchText =
              searchRes.content[0]?.type === "text" ? searchRes.content[0].text : "";
            assert.include(searchText, echoToolName);

            // Echo tool round-trips through McpServer.
            const echoRes = yield* server
              .callTool({ name: echoToolName, arguments: { text: "hello" } })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
                Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
              );
            assert.notStrictEqual(echoRes.isError, true);
            assert.strictEqual(
              echoRes.content[0]?.type === "text" ? echoRes.content[0].text : "",
              "echo:hello",
            );

            // Env check: receives plugin paths and expanded env, omits T3CODE_* secret.
            const envRes = yield* server
              .callTool({ name: envToolName, arguments: {} })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
                Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
              );
            assert.notStrictEqual(envRes.isError, true);
            const envPayload = decodeJson(
              envRes.content[0]?.type === "text" ? envRes.content[0].text : "{}",
            ) as Readonly<Record<string, unknown>>;
            assert.strictEqual(envPayload.t3Secret, null);
            assert.strictEqual(envPayload.customVar, "expanded-from-parent");
            assert.strictEqual(envPayload.fallbackVar, "default-val");
            assert.isString(envPayload.pluginRoot);
            assert.strictEqual(envPayload.pluginRoot, envPayload.t3PluginRoot);
            assert.isString(envPayload.pluginData);

            // Upstream error becomes isError: true text result.
            const failRes = yield* server
              .callTool({ name: failToolName, arguments: {} })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
                Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
              );
            assert.strictEqual(failRes.isError, true);
            assert.match(
              failRes.content[0]?.type === "text" ? failRes.content[0].text : "",
              /upstream boom/i,
            );

            // Outside read-only client is hidden from calling plugin tools by EnabledWhen.
            const outsideCallErr = yield* server
              .callTool({ name: echoToolName, arguments: { text: "nope" } })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
                Effect.provideService(
                  McpInvocationContext.McpInvocationContext,
                  readOnlyClientInvocation,
                ),
                Effect.flip,
              );
            assert.match(outsideCallErr.message, /not found/i);

            // Read-only client reaching the handler is refused by McpToolAccess.refuseReadOnlyClient.
            const roRes = yield* server
              .callTool({ name: echoToolName, arguments: { text: "nope" } })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
                Effect.provideService(McpInvocationContext.McpInvocationContext, {
                  ...threadInvocation,
                  client: readOnlyClientInvocation.client,
                }),
              );
            assert.strictEqual(roRes.isError, true);
            assert.match(
              roRes.content[0]?.type === "text" ? roRes.content[0].text : "",
              /read-only/i,
            );

            // Disabling the plugin stops the server and removes its tools from visibility and calls.
            yield* registry.setEnabled("demo-mcp", false);
            yield* nextMatchingEvent(
              eventQueue,
              (event) =>
                event.pluginId === "demo-mcp" &&
                event.serverName === "local" &&
                event.type === "stopped",
            );
            assert.isFalse(proxy.isToolActive(echoToolName));
            const afterDisableVisible = yield* visibleNames().pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, threadInvocation),
            );
            assert.notInclude(afterDisableVisible, echoToolName);
          }),
          {
            extraHostEnv: {
              T3CODE_SECRET_TEST: "top-secret-should-not-leak",
              HOST_CUSTOM_FOR_PLUGIN: "expanded-from-parent",
            },
          },
        );
      }),
  );

  it.live(
    "retries failed starts up to 3 times, reports failed, and resets when toggled off and on",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        yield* withProxyHarness(
          Effect.gen(function* () {
            const registry = yield* PluginRegistry.PluginRegistry;
            const proxy = yield* PluginMcpProxy.PluginMcpProxy;
            const eventQueue = yield* proxy.events.pipe(Stream.toQueue({ capacity: "unbounded" }));

            const written = yield* registry.write({
              id: "flaky-mcp",
              mcpServers: {
                broken: { command: "does-not-matter" },
              },
            });
            yield* registry.setEnabled("flaky-mcp", true, {
              approveExternal: true,
              revision: written.after,
            });

            const failedEvent = yield* nextMatchingEvent(
              eventQueue,
              (event) => event.pluginId === "flaky-mcp" && event.type === "failed",
            );
            assert.strictEqual(attempts, 4);
            assert.match(failedEvent.error ?? "", /connect failed/i);

            const listed = yield* registry.list;
            const serverStatus = listed.plugins.find((p) => p.id === "flaky-mcp")?.mcpServers?.[0];
            assert.strictEqual(serverStatus?.status, "failed");
            assert.match(serverStatus?.error ?? "", /connect failed/i);

            // Toggling off and back on resets retries and starts again.
            yield* registry.setEnabled("flaky-mcp", false);
            yield* nextMatchingEvent(
              eventQueue,
              (event) => event.pluginId === "flaky-mcp" && event.type === "stopped",
            );
            const beforeToggleOn = attempts;
            yield* registry.setEnabled("flaky-mcp", true);
            yield* nextMatchingEvent(
              eventQueue,
              (event) => event.pluginId === "flaky-mcp" && event.type === "failed",
            );
            assert.strictEqual(attempts - beforeToggleOn, 4);
          }),
          {
            proxyOptions: {
              retryBackoffs: [Duration.zero, Duration.zero, Duration.zero],
              transportFactory: () =>
                Effect.suspend(() => {
                  attempts += 1;
                  return Effect.fail(
                    new McpClientError.McpClientError({
                      reason: new McpClientError.TransportError({
                        description: "connect failed",
                        cause: new Error("connect failed"),
                      }),
                    }),
                  );
                }),
            },
          },
        );
      }),
  );

  it.live("caps tools at 64 per server and reports truncatedTools", () =>
    Effect.gen(function* () {
      const fixturePath = yield* Path.Path.pipe(
        Effect.flatMap((path) => path.fromFileUrl(FIXTURE_SCRIPT)),
        Effect.provide(NodeServices.layer),
      );

      yield* withProxyHarness(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const proxy = yield* PluginMcpProxy.PluginMcpProxy;
          const eventQueue = yield* proxy.events.pipe(Stream.toQueue({ capacity: "unbounded" }));

          const written = yield* registry.write({
            id: "big-mcp",
            mcpServers: {
              many: {
                command: process.execPath,
                args: [fixturePath, "--count", "70"],
              },
            },
          });
          yield* registry.setEnabled("big-mcp", true, {
            approveExternal: true,
            revision: written.after,
          });
          const running = yield* nextMatchingEvent(
            eventQueue,
            (event) => event.pluginId === "big-mcp" && event.type === "running",
          );
          assert.strictEqual(running.toolCount, 64);
          assert.strictEqual(running.truncatedTools, true);
          assert.strictEqual(proxy.listActiveTools().length, 64);
        }),
      );
    }),
  );
});
