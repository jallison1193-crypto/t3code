import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { isHiddenChatShortcutInWorkMode } from "./components/chat/workModeChrome.logic";
import { resolveChatShortcutCommand } from "./keybindings";
import {
  commandForPluginCommand,
  commandForPluginPanel,
  isPluginKeybindingCommand,
  pluginCommandFromKeybinding,
  pluginPanelFromKeybinding,
} from "./pluginKeybindings";

describe("pluginKeybindings", () => {
  it("round-trips valid plugin command and panel keybindings", () => {
    const slashCommand = commandForPluginCommand("daily-tools", "standup-notes");
    expect(slashCommand).toBe("plugin.daily-tools.command.standup-notes");
    expect(pluginCommandFromKeybinding(slashCommand!)).toEqual({
      pluginId: "daily-tools",
      commandName: "standup-notes",
    });
    expect(pluginCommandFromKeybinding(`  ${slashCommand}  `)).toEqual({
      pluginId: "daily-tools",
      commandName: "standup-notes",
    });
    expect(pluginPanelFromKeybinding(slashCommand!)).toBeNull();
    expect(isPluginKeybindingCommand(slashCommand!)).toBe(true);

    const panelCommand = commandForPluginPanel("pomodoro", "focus-timer");
    expect(panelCommand).toBe("plugin.pomodoro.panel.focus-timer");
    expect(pluginPanelFromKeybinding(panelCommand!)).toEqual({
      pluginId: "pomodoro",
      panelId: "focus-timer",
    });
    expect(pluginPanelFromKeybinding(` ${panelCommand} `)).toEqual({
      pluginId: "pomodoro",
      panelId: "focus-timer",
    });
    expect(pluginCommandFromKeybinding(panelCommand!)).toBeNull();
    expect(isPluginKeybindingCommand(panelCommand!)).toBe(true);
  });

  it.each([
    ["", "standup"],
    ["daily-tools", ""],
    ["a.b", "standup"],
    ["daily-tools", "a.b"],
    ["Daily", "standup"],
    ["daily-tools", "Standup"],
    ["-daily", "standup"],
    ["daily-", "standup"],
    ["daily--tools", "standup"],
    ["a".repeat(65), "standup"],
    ["daily-tools", "b".repeat(65)],
  ])("returns null when building invalid plugin keybindings (%j, %j)", (pluginId, targetId) => {
    expect(commandForPluginCommand(pluginId, targetId)).toBeNull();
    expect(commandForPluginPanel(pluginId, targetId)).toBeNull();
  });

  it.each([
    "chat.new",
    "script.build.run",
    "plugin.a.b.command.c",
    "plugin.a.command.b.c",
    "plugin.a.command.b.command.c",
    "plugin.a.b.panel.c",
    "plugin.a.panel.b.c",
    "plugin.Foo.command.bar",
    "plugin..command.bar",
    "plugin.foo.command.",
    "plugin.foo.other.bar",
    `plugin.${"a".repeat(65)}.panel.bar`,
  ])("returns null when parsing invalid or non-plugin command %j", (raw) => {
    expect(pluginCommandFromKeybinding(raw)).toBeNull();
    expect(pluginPanelFromKeybinding(raw)).toBeNull();
    expect(isPluginKeybindingCommand(raw)).toBe(false);
  });

  it("does not block plugin shortcuts in work mode", () => {
    expect(isHiddenChatShortcutInWorkMode("plugin.daily-tools.command.standup")).toBe(false);
    expect(isHiddenChatShortcutInWorkMode("plugin.pomodoro.panel.timer")).toBe(false);
  });

  it("resolves plugin shortcuts from the active environment while keeping primary app shortcuts ahead", () => {
    const primary = compileResolvedKeybindingsConfig([
      { command: "commandPalette.toggle", key: "mod+k" },
      { command: "plugin.local.command.standup", key: "mod+shift+1" },
    ]);
    const active = compileResolvedKeybindingsConfig([
      { command: "plugin.remote.command.deploy", key: "mod+k" },
      { command: "plugin.remote.panel.monitor", key: "mod+shift+2" },
    ]);
    const keyEvent = (key: string, shiftKey = false) => ({
      key,
      metaKey: false,
      ctrlKey: true,
      shiftKey,
      altKey: false,
    });

    expect(
      resolveChatShortcutCommand(keyEvent("2", true), primary, active, { platform: "Linux" }),
    ).toBe("plugin.remote.panel.monitor");
    expect(
      resolveChatShortcutCommand(keyEvent("1", true), primary, active, { platform: "Linux" }),
    ).toBeNull();
    expect(resolveChatShortcutCommand(keyEvent("k"), primary, active, { platform: "Linux" })).toBe(
      "commandPalette.toggle",
    );

    const singleEnv = compileResolvedKeybindingsConfig([
      { command: "commandPalette.toggle", key: "mod+k" },
      { command: "plugin.daily.command.standup", key: "mod+k" },
    ]);
    expect(
      resolveChatShortcutCommand(keyEvent("k"), singleEnv, singleEnv, { platform: "Linux" }),
    ).toBe("plugin.daily.command.standup");
  });
});
