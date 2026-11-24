import { ProjectId, type EnvironmentPlugin } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildKeybindingCommandOptions,
  buildKeybindingRows,
  commandLabel,
  filterKeybindingRows,
  groupKeybindingRows,
} from "./KeybindingsSettings.logic";

const PLUGINS: ReadonlyArray<EnvironmentPlugin> = [
  {
    id: "daily-tools",
    displayName: "Daily Tools",
    css: "",
    commands: [{ name: "standup" }, { name: "review" }, { name: "model" }],
    panels: [{ id: "focus-timer", title: "Pomodoro Timer" }],
  },
  {
    id: "code-helper",
    css: "",
    commands: [{ name: "review" }],
  },
];

describe("KeybindingsSettings.logic plugin keybindings", () => {
  it("groups plugin bindings under Plugins after Project scripts with Custom source", () => {
    const bindings = compileResolvedKeybindingsConfig([
      { command: "script.test.run", key: "mod+shift+t" },
      { command: "plugin.daily-tools.command.standup", key: "mod+shift+1" },
      { command: "plugin.daily-tools.panel.focus-timer", key: "mod+shift+2" },
    ]);
    const rows = buildKeybindingRows(bindings, "Linux", "enter", undefined, PLUGINS);
    const groups = groupKeybindingRows(rows);

    expect(groups.map((group) => group.id)).toEqual(["scripts", "plugins"]);
    expect(groups[1]?.rows.map((row) => ({ command: row.command, source: row.source }))).toEqual([
      { command: "plugin.daily-tools.command.standup", source: "Custom" },
      { command: "plugin.daily-tools.panel.focus-timer", source: "Custom" },
    ]);
  });

  it("formats plugin command and panel labels with present plugins and falls back when missing", () => {
    expect(commandLabel("plugin.daily-tools.command.standup", undefined, PLUGINS)).toBe(
      "Plugin: Daily Tools: /standup",
    );
    expect(commandLabel("plugin.daily-tools.command.review", undefined, PLUGINS)).toBe(
      "Plugin: Daily Tools: /daily-tools:review",
    );
    expect(commandLabel("plugin.daily-tools.command.model", undefined, PLUGINS)).toBe(
      "Plugin: Daily Tools: /daily-tools:model",
    );
    expect(commandLabel("plugin.code-helper.command.review", undefined, PLUGINS)).toBe(
      "Plugin: code-helper: /code-helper:review",
    );
    expect(commandLabel("plugin.daily-tools.panel.focus-timer", undefined, PLUGINS)).toBe(
      "Plugin: Daily Tools: Open Pomodoro Timer",
    );

    // Missing plugin or legacy call without plugin lookup falls back to title-cased ids.
    expect(commandLabel("plugin.daily-tools.command.standup")).toBe(
      "Plugin: Daily Tools: /standup",
    );
    expect(commandLabel("plugin.daily-tools.panel.focus-timer")).toBe(
      "Plugin: Daily Tools: Open Focus Timer",
    );
    expect(commandLabel("plugin.removed-plugin.panel.side-notes", undefined, PLUGINS)).toBe(
      "Plugin: Removed Plugin: Open Side Notes",
    );
  });

  it("includes applicable plugin commands and panels in command options and supports label search", () => {
    const existing = compileResolvedKeybindingsConfig([
      { command: "plugin.removed-plugin.command.legacy", key: "mod+shift+9" },
      { command: "plugin.daily-tools.panel.focus-timer", key: "mod+shift+2" },
    ]);
    const options = buildKeybindingCommandOptions(existing, undefined, PLUGINS);

    expect(options).toContain("plugin.daily-tools.command.standup");
    expect(options).toContain("plugin.daily-tools.command.review");
    expect(options).toContain("plugin.daily-tools.panel.focus-timer");
    expect(options).toContain("plugin.code-helper.command.review");
    expect(options).toContain("plugin.removed-plugin.command.legacy");

    const rows = buildKeybindingRows(existing, "Linux", "enter", undefined, PLUGINS);
    expect(filterKeybindingRows(rows, "Pomodoro Timer", undefined, PLUGINS)).toHaveLength(1);
    expect(filterKeybindingRows(rows, "Pomodoro Timer", undefined, PLUGINS)[0]?.command).toBe(
      "plugin.daily-tools.panel.focus-timer",
    );

    // Repo plugin entries only appear when passed in the applicable plugins list.
    const withRepo: ReadonlyArray<EnvironmentPlugin> = [
      ...PLUGINS,
      {
        id: "repo-ops",
        displayName: "Repo Ops",
        css: "",
        projectId: ProjectId.make("project-1"),
        commands: [{ name: "deploy" }],
      },
    ];
    expect(options).not.toContain("plugin.repo-ops.command.deploy");
    expect(buildKeybindingCommandOptions(existing, undefined, withRepo)).toContain(
      "plugin.repo-ops.command.deploy",
    );
  });
});
