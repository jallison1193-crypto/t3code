import { ProjectId, type EnvironmentPlugin } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPluginCommandShortcut,
  resolvePluginSlashCommands,
} from "./pluginSlashCommands.logic";

const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

function makePlugin(
  overrides: Partial<EnvironmentPlugin> & Pick<EnvironmentPlugin, "id">,
): EnvironmentPlugin {
  return {
    css: "",
    ...overrides,
  };
}

describe("resolvePluginSlashCommands", () => {
  it("uses short invocations for unique names and qualifies colliding or built-in names", () => {
    const plugins: ReadonlyArray<EnvironmentPlugin> = [
      makePlugin({
        id: "alpha",
        displayName: "Alpha",
        commands: [
          { name: "standup", description: "Daily standup", argumentHint: "[topic]" },
          { name: "review", description: "Alpha review" },
          { name: "model", description: "Collides with built-in" },
        ],
      }),
      makePlugin({
        id: "beta",
        commands: [{ name: "review", description: "Beta review" }],
      }),
    ];

    expect(resolvePluginSlashCommands(plugins, null)).toEqual([
      {
        pluginId: "alpha",
        pluginName: "Alpha",
        commandName: "standup",
        invocation: "standup",
        description: "Daily standup",
        argumentHint: "[topic]",
      },
      {
        pluginId: "alpha",
        pluginName: "Alpha",
        commandName: "review",
        invocation: "alpha:review",
        description: "Alpha review",
      },
      {
        pluginId: "alpha",
        pluginName: "Alpha",
        commandName: "model",
        invocation: "alpha:model",
        description: "Collides with built-in",
      },
      {
        pluginId: "beta",
        pluginName: "beta",
        commandName: "review",
        invocation: "beta:review",
        description: "Beta review",
      },
    ]);
  });

  it("includes repo plugins only for their active project and lets matching repo commands override global ones", () => {
    const plugins: ReadonlyArray<EnvironmentPlugin> = [
      makePlugin({
        id: "shared",
        displayName: "Global Shared",
        commands: [{ name: "check", description: "Global check" }],
      }),
      makePlugin({
        id: "shared",
        displayName: "Repo A Shared",
        projectId: PROJECT_A,
        commands: [{ name: "check", description: "Repo A check" }],
      }),
      makePlugin({
        id: "team-b",
        displayName: "Team B",
        projectId: PROJECT_B,
        commands: [{ name: "check" }, { name: "deploy" }],
      }),
    ];

    expect(resolvePluginSlashCommands(plugins, PROJECT_A)).toEqual([
      {
        pluginId: "shared",
        pluginName: "Repo A Shared",
        commandName: "check",
        invocation: "check",
        description: "Repo A check",
      },
    ]);

    expect(resolvePluginSlashCommands(plugins, null)).toEqual([
      {
        pluginId: "shared",
        pluginName: "Global Shared",
        commandName: "check",
        invocation: "check",
        description: "Global check",
      },
    ]);

    expect(resolvePluginSlashCommands(plugins, PROJECT_B).map((entry) => entry.invocation)).toEqual(
      ["shared:check", "team-b:check", "deploy"],
    );
  });
});

describe("applyPluginCommandShortcut", () => {
  it.each([
    {
      name: "empty prompt",
      value: "",
      invocation: "standup",
      expected: "/standup ",
    },
    {
      name: "whitespace-only prompt",
      value: "   \n\t ",
      invocation: "standup",
      expected: "/standup ",
    },
    {
      name: "plain text prompt",
      value: "summarize open PRs",
      invocation: "standup",
      expected: "/standup summarize open PRs",
    },
    {
      name: "bare slash",
      value: "/",
      invocation: "standup",
      expected: "/standup ",
    },
    {
      name: "existing slash token without args",
      value: "/old",
      invocation: "standup",
      expected: "/standup ",
    },
    {
      name: "existing slash token with trailing space only",
      value: "/old   ",
      invocation: "standup",
      expected: "/standup ",
    },
    {
      name: "existing slash token with args",
      value: "/old-plugin:draft fix tests",
      invocation: "daily:standup",
      expected: "/daily:standup fix tests",
    },
    {
      name: "leading whitespace before slash token with args",
      value: "  /old keep args",
      invocation: "standup",
      expected: "/standup keep args",
    },
    {
      name: "slash token followed by newline",
      value: "/old\nsecond line",
      invocation: "standup",
      expected: "/standup\nsecond line",
    },
    {
      name: "same command repeated is idempotent",
      value: "/standup keep args",
      invocation: "standup",
      expected: "/standup keep args",
    },
  ])("$name", ({ value, invocation, expected }) => {
    expect(applyPluginCommandShortcut(value, invocation)).toEqual({
      value: expected,
      cursor: expected.length,
    });
  });
});
