import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PLUGIN_INSTRUCTIONS_MAX_BYTES,
  PLUGIN_PANEL_HTML_MAX_CHARS,
  PluginId,
  PluginOperationError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PluginRegistry from "../../../plugins/PluginRegistry.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PluginHandlers from "./handlers.ts";
import { PluginToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:plugin");
const threadId = ThreadId.make("thread:plugin");

const makeThreadScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:plugin",
  thread: {
    threadId,
    providerSessionId: "provider:plugin",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const readOnlyClientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:plugin",
  thread: undefined,
  client: {
    sessionId: "session",
    label: "Read-only Client",
    access: "read-only",
  },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const runWithRegistry = (
  registry: Partial<PluginRegistry.PluginRegistry["Service"]>,
  options: {
    readonly scope?: McpInvocationContext.McpInvocationScope;
    readonly runtimeMode?: "full-access" | "auto";
  } = {},
) => {
  const layerDependencies = Layer.mergeAll(
    ThreadCommandExecutor.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, options.scope ?? makeThreadScope()),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(
          liveThreadShell(threadId, {
            runtimeMode: options.runtimeMode ?? "full-access",
          }),
        ),
    }),
    Layer.mock(PluginRegistry.PluginRegistry)(registry),
  );
  return McpToolAccess.HandlersLayer.layer(PluginHandlers.layer).pipe(
    Layer.provideMerge(layerDependencies),
  );
};

it.effect("reads plugins, returns one plugin's CSS, and includes the plugin + theme guide", () =>
  Effect.gen(function* () {
    const layer = runWithRegistry({
      list: Effect.succeed({
        pluginsDir: "/state/plugins",
        plugins: [
          {
            id: "compact-sidebar",
            displayName: "Compact Sidebar",
            description: "Tighter rows.",
            version: "1.0.0",
            enabled: false,
            contributes: ["css" as const],
            revision: "0123456789ab",
          },
        ],
      }),
      read: (id) =>
        id === "compact-sidebar"
          ? Effect.succeed({
              displayName: "Compact Sidebar",
              description: "Tighter rows.",
              version: "1.0.0",
              css: "[data-thread-item] { padding-block: 2px; }",
            })
          : Effect.fail(
              new PluginOperationError({
                pluginId: id,
                operation: "read",
                reason: "not_found",
              }),
            ),
    });

    yield* Effect.gen(function* () {
      const toolkit = yield* PluginToolkit;
      const callRead = (params: Parameters<typeof toolkit.handle<"t3_plugin_read">>[1]) =>
        toolkit.handle("t3_plugin_read", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      const listed = yield* callRead({});
      expect(listed).toMatchObject({
        pluginsDir: "/state/plugins",
        plugins: [
          {
            id: "compact-sidebar",
            displayName: "Compact Sidebar",
            enabled: false,
            contributes: ["css"],
            revision: "0123456789ab",
          },
        ],
        guide: expect.stringContaining(THEME_GUIDE),
      });
      expect(listed).toMatchObject({
        guide: expect.stringMatching(/layered after the active theme/i),
      });

      const detailed = yield* callRead({ pluginId: "compact-sidebar" });
      expect(detailed).toMatchObject({
        pluginsDir: "/state/plugins",
        plugin: {
          displayName: "Compact Sidebar",
          description: "Tighter rows.",
          version: "1.0.0",
          css: "[data-thread-item] { padding-block: 2px; }",
        },
      });

      const missing = yield* callRead({ pluginId: "missing" });
      expect(missing).toMatchObject({
        code: "invalid_request",
        message: 'Plugin "missing" is not installed.',
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("writes plugins with authoritative applied/next fields and maps errors", () =>
  Effect.gen(function* () {
    const layer = runWithRegistry({
      write: (input) => {
        if (input.id === "new-plugin") {
          return Effect.succeed({
            plugin: {
              id: "new-plugin",
              displayName: input.displayName,
              enabled: false,
              contributes: ["css" as const],
              revision: "aaaaaaaaaaaa",
            },
            created: true,
            after: "aaaaaaaaaaaa",
          });
        }
        if (input.id === "live-plugin") {
          return Effect.succeed({
            plugin: {
              id: "live-plugin",
              enabled: true,
              contributes: ["css" as const],
              revision: "bbbbbbbbbbbb",
            },
            created: false,
            before: "aaaaaaaaaaaa",
            after: "bbbbbbbbbbbb",
          });
        }
        if (input.id === "off-plugin") {
          return Effect.succeed({
            plugin: {
              id: "off-plugin",
              enabled: false,
              contributes: ["css" as const],
              revision: "cccccccccccc",
            },
            created: false,
            before: "aaaaaaaaaaaa",
            after: "cccccccccccc",
          });
        }
        if (input.id === "bad-css") {
          return Effect.fail(
            new PluginOperationError({
              pluginId: input.id,
              operation: "write",
              reason: "invalid_css",
            }),
          );
        }
        return Effect.fail(
          new PluginOperationError({
            pluginId: input.id,
            operation: "write",
            reason: "write_failed",
          }),
        );
      },
    });

    yield* Effect.gen(function* () {
      const toolkit = yield* PluginToolkit;
      const callWrite = (params: Parameters<typeof toolkit.handle<"t3_plugin_write">>[1]) =>
        toolkit.handle("t3_plugin_write", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      expect(
        yield* callWrite({
          pluginId: "new-plugin",
          displayName: "New Plugin",
          css: "[data-chat-header] { opacity: 0.9; }",
        }),
      ).toEqual({
        pluginId: "new-plugin",
        created: true,
        enabled: false,
        applied: false,
        contributes: ["css"],
        after: "aaaaaaaaaaaa",
        next: "The user turns it on with Install on the card in the chat.",
      });

      expect(
        yield* callWrite({
          pluginId: "live-plugin",
          css: "[data-chat-header] { opacity: 0.8; }",
        }),
      ).toEqual({
        pluginId: "live-plugin",
        created: false,
        enabled: true,
        applied: true,
        contributes: ["css"],
        before: "aaaaaaaaaaaa",
        after: "bbbbbbbbbbbb",
        next: "Live now; the user can Undo from the card.",
      });

      expect(
        yield* callWrite({
          pluginId: "off-plugin",
          css: "[data-chat-header] { opacity: 0.7; }",
        }),
      ).toEqual({
        pluginId: "off-plugin",
        created: false,
        enabled: false,
        applied: false,
        contributes: ["css"],
        before: "aaaaaaaaaaaa",
        after: "cccccccccccc",
        next: "Saved; it is off, so turn it on in Settings > Plugins.",
      });

      expect(
        yield* callWrite({
          pluginId: "bad-css",
          css: "@import url(https://example.com/x.css);",
        }),
      ).toMatchObject({
        code: "invalid_request",
        message: 'CSS for plugin "bad-css" exceeds the size limit or loads remote files.',
      });

      expect(
        yield* callWrite({
          pluginId: "disk-error",
          css: ":root {}",
        }),
      ).toMatchObject({
        code: "orchestration_error",
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses plugin writes without full-access or from read-only clients", () =>
  Effect.gen(function* () {
    const autoLayer = runWithRegistry(
      {
        write: () => Effect.die("must not write without full-access"),
      },
      { runtimeMode: "auto" },
    );
    const autoResult = yield* Effect.gen(function* () {
      const toolkit = yield* PluginToolkit;
      return yield* toolkit.handle("t3_plugin_write", { pluginId: "demo", css: ":root {}" }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
      );
    }).pipe(Effect.provide(autoLayer));
    expect(autoResult).toMatchObject({
      code: "capability_denied",
      message: expect.stringMatching(/full-access/i),
    });

    const readOnlyLayer = runWithRegistry(
      {
        write: () => Effect.die("must not write from read-only client"),
      },
      { scope: readOnlyClientScope },
    );
    const readOnlyResult = yield* Effect.gen(function* () {
      const toolkit = yield* PluginToolkit;
      return yield* toolkit.handle("t3_plugin_write", { pluginId: "demo", css: ":root {}" }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
      );
    }).pipe(Effect.provide(readOnlyLayer));
    expect(readOnlyResult).toMatchObject({ code: "capability_denied" });
  }),
);

it("advertises Gemini-compatible JSON schemas with only string enums", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(PluginToolkit.tools.t3_plugin_read));
  collect(advertisedJsonSchema(PluginToolkit.tools.t3_plugin_write));
  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});

it.effect("writes and reads panel plugins and rejects empty or oversized panel writes", () =>
  Effect.gen(function* () {
    const html = "<!doctype html><html><body>Pomodoro</body></html>";
    const layer = runWithRegistry({
      list: Effect.succeed({
        pluginsDir: "/state/plugins",
        plugins: [
          {
            id: "pomodoro",
            displayName: "Pomodoro",
            enabled: true,
            contributes: ["panel" as const],
            panels: [{ id: "timer", title: "Pomodoro" }],
            revision: "111111111111",
          },
        ],
      }),
      read: (id) =>
        id === "pomodoro"
          ? Effect.succeed({
              displayName: "Pomodoro",
              panels: [{ id: "timer", title: "Pomodoro", html }],
            })
          : Effect.fail(
              new PluginOperationError({
                pluginId: id,
                operation: "read",
                reason: "not_found",
              }),
            ),
      write: (input) =>
        Effect.succeed({
          plugin: {
            id: input.id,
            displayName: input.displayName,
            enabled: false,
            contributes: [
              ...(input.css !== undefined ? (["css"] as const) : []),
              ...(input.panels?.length ? (["panel"] as const) : []),
            ],
            ...(input.panels?.length
              ? { panels: input.panels.map(({ id, title }) => ({ id, title })) }
              : {}),
            revision: "222222222222",
          },
          created: true,
          after: "222222222222",
        }),
    });

    yield* Effect.gen(function* () {
      const toolkit = yield* PluginToolkit;
      const callRead = (params: Parameters<typeof toolkit.handle<"t3_plugin_read">>[1]) =>
        toolkit.handle("t3_plugin_read", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );
      const callWrite = (params: Parameters<typeof toolkit.handle<"t3_plugin_write">>[1]) =>
        toolkit.handle("t3_plugin_write", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      expect(
        yield* callWrite({
          pluginId: "pomodoro",
          displayName: "Pomodoro",
          panels: [{ id: "timer", title: "Pomodoro", html }],
        }),
      ).toEqual({
        pluginId: "pomodoro",
        created: true,
        enabled: false,
        applied: false,
        contributes: ["panel"],
        after: "222222222222",
        next: "The user turns it on with Install on the card in the chat.",
      });

      const listed = yield* callRead({});
      expect(listed).toMatchObject({
        plugins: [
          {
            id: "pomodoro",
            contributes: ["panel"],
            panels: [{ id: "timer", title: "Pomodoro" }],
          },
        ],
        guide: expect.stringContaining("t3_plugin_state_get"),
      });

      const detailed = yield* callRead({ pluginId: "pomodoro" });
      expect(detailed).toMatchObject({
        plugin: {
          displayName: "Pomodoro",
          panels: [{ id: "timer", title: "Pomodoro", html }],
        },
      });

      expect(yield* callWrite({ pluginId: "empty-plugin" })).toMatchObject({
        code: "invalid_request",
      });

      expect(
        yield* callWrite({
          pluginId: "too-big",
          panels: [{ id: "main", title: "Big", html: "a".repeat(PLUGIN_PANEL_HTML_MAX_CHARS + 1) }],
        }),
      ).toMatchObject({
        code: "invalid_request",
      });

      expect(
        yield* callWrite({
          pluginId: "pomodoro",
          panels: [{ id: "timer", title: "Pomodoro: 25 minute focus and 5 minute break", html }],
        }),
      ).toMatchObject({
        code: "invalid_request",
        message: 'Panel "timer" title must be 1 to 40 characters.',
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "writes and reads worker plugins, tells the agent when folders must be picked, and documents workers in the guide",
  () =>
    Effect.gen(function* () {
      const workerCode = "export default (t3) => t3.onRun(async () => { t3.log('sync'); });\n";
      const layer = runWithRegistry({
        list: Effect.succeed({
          pluginsDir: "/state/plugins",
          plugins: [
            {
              id: "vault-sync",
              displayName: "Vault Sync",
              enabled: false,
              contributes: ["worker" as const],
              worker: {
                everyMinutes: 15,
                folders: [
                  {
                    id: "vault",
                    label: "Obsidian vault folder",
                    access: "write" as const,
                    path: null,
                  },
                ],
                network: false,
                status: "stopped" as const,
                networkRestricted: false,
              },
              revision: "333333333333",
            },
          ],
        }),
        read: (id) =>
          id === "vault-sync"
            ? Effect.succeed({
                displayName: "Vault Sync",
                worker: {
                  code: workerCode,
                  everyMinutes: 15,
                  folders: [
                    { id: "vault", label: "Obsidian vault folder", access: "write" as const },
                  ],
                  network: false,
                },
              })
            : Effect.fail(
                new PluginOperationError({
                  pluginId: id,
                  operation: "read",
                  reason: "not_found",
                }),
              ),
        write: (input) =>
          Effect.succeed({
            plugin: {
              id: input.id,
              displayName: input.displayName,
              enabled: false,
              contributes: ["worker" as const],
              worker: {
                ...(input.worker?.everyMinutes === undefined
                  ? {}
                  : { everyMinutes: input.worker.everyMinutes }),
                folders: (input.worker?.folders ?? []).map((folder) => ({
                  ...folder,
                  path: null,
                })),
                network: input.worker?.network === true,
                status: "stopped" as const,
                networkRestricted: false,
              },
              revision: "333333333333",
            },
            created: true,
            after: "333333333333",
          }),
      });

      yield* Effect.gen(function* () {
        const toolkit = yield* PluginToolkit;
        const callRead = (params: Parameters<typeof toolkit.handle<"t3_plugin_read">>[1]) =>
          toolkit.handle("t3_plugin_read", params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );
        const callWrite = (params: Parameters<typeof toolkit.handle<"t3_plugin_write">>[1]) =>
          toolkit.handle("t3_plugin_write", params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );

        const written = yield* callWrite({
          pluginId: "vault-sync",
          displayName: "Vault Sync",
          worker: {
            code: workerCode,
            everyMinutes: 15,
            folders: [{ id: "vault", label: "Obsidian vault folder", access: "write" }],
            network: false,
          },
        });
        expect(written).toEqual({
          pluginId: "vault-sync",
          created: true,
          enabled: false,
          applied: false,
          contributes: ["worker"],
          worker: {
            everyMinutes: 15,
            folders: [{ id: "vault", label: "Obsidian vault folder", access: "write" }],
            network: false,
          },
          after: "333333333333",
          next: "The user turns it on with Install on the card in the chat, then picks its folder path(s) in Settings > Plugins before the worker can run.",
        });

        const detailed = yield* callRead({ pluginId: "vault-sync" });
        expect(detailed).toMatchObject({
          plugin: {
            displayName: "Vault Sync",
            worker: {
              code: workerCode,
              everyMinutes: 15,
              folders: [{ id: "vault", label: "Obsidian vault folder", access: "write" }],
              network: false,
            },
          },
          guide: expect.stringMatching(/Settings > Plugins.*t3\.projects\.readMemory/s),
        });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "writes and reads skills and instructions plugins and documents /standup in the guide",
  () =>
    Effect.gen(function* () {
      const standupSkill = {
        name: PluginId.make("standup"),
        description: "Summarize recent commits",
        argumentHint: "[focus]",
        userInvocable: true,
        modelInvocable: false,
        body: "Summarize git log for $ARGUMENTS.",
      };
      const layer = runWithRegistry({
        list: Effect.succeed({
          pluginsDir: "/state/plugins",
          plugins: [
            {
              id: "daily-kit",
              displayName: "Daily Kit",
              enabled: false,
              contributes: ["command" as const, "instructions" as const],
              commands: [PluginId.make("standup")],
              revision: "444444444444",
            },
          ],
          repoPlugins: [],
        }),
        read: (id) =>
          id === "daily-kit"
            ? Effect.succeed({
                displayName: "Daily Kit",
                skills: [standupSkill],
                instructions: "Keep standups concise.",
              })
            : Effect.fail(
                new PluginOperationError({
                  pluginId: id,
                  operation: "read",
                  reason: "not_found",
                }),
              ),
        write: (input) =>
          Effect.succeed({
            plugin: {
              id: input.id,
              displayName: input.displayName,
              enabled: false,
              contributes: [
                ...(input.skills?.some((skill) => skill.userInvocable !== false)
                  ? (["command"] as const)
                  : []),
                ...(input.skills?.some((skill) => skill.modelInvocable !== false)
                  ? (["skill"] as const)
                  : []),
                ...(input.instructions?.trim() ? (["instructions"] as const) : []),
              ],
              ...(input.skills?.some((skill) => skill.userInvocable !== false)
                ? {
                    commands: input.skills
                      .filter((skill) => skill.userInvocable !== false)
                      .map((skill) => skill.name),
                  }
                : {}),
              revision: "444444444444",
            },
            created: true,
            after: "444444444444",
          }),
      });

      yield* Effect.gen(function* () {
        const toolkit = yield* PluginToolkit;
        const callRead = (params: Parameters<typeof toolkit.handle<"t3_plugin_read">>[1]) =>
          toolkit.handle("t3_plugin_read", params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );
        const callWrite = (params: Parameters<typeof toolkit.handle<"t3_plugin_write">>[1]) =>
          toolkit.handle("t3_plugin_write", params).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result),
          );

        expect(
          yield* callWrite({
            pluginId: "daily-kit",
            displayName: "Daily Kit",
            skills: [standupSkill],
            instructions: "Keep standups concise.",
          }),
        ).toEqual({
          pluginId: "daily-kit",
          created: true,
          enabled: false,
          applied: false,
          contributes: ["command", "instructions"],
          commands: ["standup"],
          after: "444444444444",
          next: "The user turns it on with Install on the card in the chat.",
        });

        const detailed = yield* callRead({ pluginId: "daily-kit" });
        expect(detailed).toMatchObject({
          plugins: [
            {
              id: "daily-kit",
              contributes: ["command", "instructions"],
              commands: ["standup"],
            },
          ],
          plugin: {
            displayName: "Daily Kit",
            skills: [standupSkill],
            instructions: "Keep standups concise.",
          },
          guide: expect.stringMatching(/\/standup.*\$ARGUMENTS/s),
        });

        expect(
          yield* callWrite({
            pluginId: "daily-kit",
            instructions: "x".repeat(PLUGIN_INSTRUCTIONS_MAX_BYTES + 1),
          }),
        ).toMatchObject({
          code: "invalid_request",
          message: "Instructions (AGENTS.md) exceed the 8 KB limit.",
        });
      }).pipe(Effect.provide(layer));
    }),
);
