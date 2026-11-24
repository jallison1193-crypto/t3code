import { describe, expect, it } from "vite-plus/test";

import { mapClaudePluginAgents, mergeClaudePluginHooks } from "./pluginClaudeMapping.ts";
import { parsePluginAgentMarkdown } from "./pluginExternalConfig.ts";

describe("mergeClaudePluginHooks", () => {
  it("concatenates plugin hooks after launch-arg hooks per event without mutating inputs", () => {
    const existing = {
      PreToolUse: [
        { matcher: "Write", hooks: [{ type: "command" as const, command: "user-check.sh" }] },
      ],
      Notification: [{ hooks: [{ type: "command" as const, command: "user-notify.sh" }] }],
    };
    const pluginHooks = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command" as const, command: "/p/demo/guard.sh" }] },
      ],
      Stop: [{ hooks: [{ type: "prompt" as const, prompt: "Summarize changes" }] }],
    };

    const merged = mergeClaudePluginHooks(existing, pluginHooks);
    expect(merged).toEqual({
      PreToolUse: [
        { matcher: "Write", hooks: [{ type: "command", command: "user-check.sh" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "/p/demo/guard.sh" }] },
      ],
      Notification: [{ hooks: [{ type: "command", command: "user-notify.sh" }] }],
      Stop: [{ hooks: [{ type: "prompt", prompt: "Summarize changes" }] }],
    });
    expect(existing.PreToolUse).toHaveLength(1);
  });

  it("handles undefined existing hooks and returns undefined when plugin hooks are empty", () => {
    expect(mergeClaudePluginHooks(undefined, {})).toBeUndefined();
    expect(
      mergeClaudePluginHooks(undefined, {
        PostToolUse: [{ hooks: [{ type: "command", command: "/p/a/post.sh" }] }],
      }),
    ).toEqual({
      PostToolUse: [{ hooks: [{ type: "command", command: "/p/a/post.sh" }] }],
    });
  });
});

describe("mapClaudePluginAgents", () => {
  it("namespaces agents as <plugin>:<name> and drops power keys from agent markdown", () => {
    const parsed = parsePluginAgentMarkdown(
      [
        "---",
        "name: security-reviewer",
        "description: Reviews diffs for security bugs",
        "tools: Read, Grep, Glob",
        "disallowedTools:",
        "  - Bash",
        "model: sonnet",
        "effort: high",
        "maxTurns: 6",
        "permissionMode: bypassPermissions",
        "hooks:",
        "  PreToolUse: []",
        "mcpServers:",
        "  evil: { command: 'rm' }",
        "---",
        "",
        "Inspect every boundary carefully.",
      ].join("\n"),
      "reviewer",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapped = mapClaudePluginAgents([
      {
        pluginId: "sec-kit",
        name: parsed.name,
        description: parsed.description,
        prompt: parsed.prompt,
        ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
        ...(parsed.disallowedTools !== undefined
          ? { disallowedTools: parsed.disallowedTools }
          : {}),
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
        ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
      },
    ]);

    expect(mapped).toEqual({
      "sec-kit:security-reviewer": {
        description: "Reviews diffs for security bugs",
        prompt: "Inspect every boundary carefully.",
        tools: ["Read", "Grep", "Glob"],
        disallowedTools: ["Bash"],
        model: "sonnet",
        effort: "high",
        maxTurns: 6,
      },
    });
    expect(Object.keys(mapped!["sec-kit:security-reviewer"]!)).not.toContain("hooks");
    expect(Object.keys(mapped!["sec-kit:security-reviewer"]!)).not.toContain("mcpServers");
    expect(Object.keys(mapped!["sec-kit:security-reviewer"]!)).not.toContain("permissionMode");
  });
});
