import { PluginId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  expandPluginSlashCommand,
  formatPluginSkillMarkdown,
  parsePluginSkillMarkdown,
  type PluginSlashCommandEntry,
} from "./pluginSlashCommand.ts";

const makeCommand = (
  overrides: Partial<PluginSlashCommandEntry> & {
    readonly pluginId: string;
    readonly name: string;
    readonly body: string;
  },
): PluginSlashCommandEntry => ({
  pluginRoot: `/plugins/${overrides.pluginId}`,
  skillDir: `/plugins/${overrides.pluginId}/skills/${overrides.name}`,
  ...overrides,
});

describe("parsePluginSkillMarkdown", () => {
  it("parses frontmatter keys, booleans, and strips frontmatter from body", () => {
    const parsed = parsePluginSkillMarkdown(
      [
        "---",
        "name: standup",
        "description: Daily summary: git and PRs",
        'argument-hint: "[focus]"',
        "disable-model-invocation: true",
        "user-invocable: yes",
        "---",
        "",
        "Summarize recent commits for $ARGUMENTS.",
      ].join("\n"),
    );
    assert.deepEqual(parsed, {
      ok: true,
      name: "standup",
      description: "Daily summary: git and PRs",
      argumentHint: "[focus]",
      userInvocable: true,
      modelInvocable: false,
      body: "Summarize recent commits for $ARGUMENTS.",
    });
  });

  it("handles missing frontmatter and round-trips formatted skill markdown", () => {
    const plain = parsePluginSkillMarkdown("Just markdown body.\n");
    assert.deepEqual(plain, {
      ok: true,
      userInvocable: true,
      modelInvocable: true,
      body: "Just markdown body.",
    });

    const formatted = formatPluginSkillMarkdown({
      name: PluginId.make("standup"),
      description: "Daily update: commits & PRs",
      argumentHint: "[since]",
      userInvocable: true,
      modelInvocable: false,
      body: "List changes since $0.",
    });
    assert.deepEqual(parsePluginSkillMarkdown(formatted), {
      ok: true,
      name: "standup",
      description: "Daily update: commits & PRs",
      argumentHint: "[since]",
      userInvocable: true,
      modelInvocable: false,
      body: "List changes since $0.",
    });
  });
});

describe("expandPluginSlashCommand", () => {
  it("substitutes $ARGUMENTS, $ARGUMENTS[N], $N, and strips frontmatter", () => {
    const commands = [
      makeCommand({
        pluginId: "ops",
        name: "deploy",
        body: [
          "---",
          "name: deploy",
          "description: Deploy a service",
          "---",
          "",
          "Service: $0",
          "Target: $ARGUMENTS[1]",
          "Full: $ARGUMENTS",
          "Missing: [$2]",
        ].join("\n"),
      }),
    ];

    assert.strictEqual(
      expandPluginSlashCommand('/deploy api "us east"', commands),
      'Service: api\nTarget: us east\nFull: api "us east"\nMissing: []',
    );
  });

  it("appends ARGUMENTS when body has no argument placeholder and args were given", () => {
    const commands = [
      makeCommand({
        pluginId: "daily",
        name: "standup",
        body: "Write a brief standup update.",
      }),
    ];

    assert.strictEqual(
      expandPluginSlashCommand("/standup focus on PRs", commands),
      "Write a brief standup update.\n\nARGUMENTS: focus on PRs",
    );
    assert.strictEqual(
      expandPluginSlashCommand("/standup", commands),
      "Write a brief standup update.",
    );
  });

  it("substitutes CLAUDE_PLUGIN_ROOT, T3_PLUGIN_ROOT, and CLAUDE_SKILL_DIR without recursive expansion", () => {
    const commands = [
      makeCommand({
        pluginId: "tools",
        name: "check",
        pluginRoot: "/srv/plugins/tools",
        skillDir: "/srv/plugins/tools/skills/check",
        body: "Run ${CLAUDE_PLUGIN_ROOT}/bin/a ${T3_PLUGIN_ROOT}/bin/b ${CLAUDE_SKILL_DIR}/c with $ARGUMENTS",
      }),
    ];

    assert.strictEqual(
      expandPluginSlashCommand("/check literal $0 ${CLAUDE_PLUGIN_ROOT}", commands),
      "Run /srv/plugins/tools/bin/a /srv/plugins/tools/bin/b /srv/plugins/tools/skills/check/c with literal $0 ${CLAUDE_PLUGIN_ROOT}",
    );
  });

  it("resolves short names when unique, requires namespaced form on ambiguity, and passes unknown commands through", () => {
    const commands = [
      makeCommand({
        pluginId: "team-a",
        name: "review",
        body: "Team A review",
      }),
      makeCommand({
        pluginId: "team-b",
        name: "review",
        body: "Team B review",
      }),
      makeCommand({
        pluginId: "team-a",
        name: "standup",
        body: "Standup body",
      }),
    ];

    assert.strictEqual(expandPluginSlashCommand("/standup", commands), "Standup body");
    assert.strictEqual(expandPluginSlashCommand("/team-a:standup", commands), "Standup body");
    assert.strictEqual(expandPluginSlashCommand("/review PR 42", commands), "/review PR 42");
    assert.strictEqual(
      expandPluginSlashCommand("/team-a:review PR 42", commands),
      "Team A review\n\nARGUMENTS: PR 42",
    );
    assert.strictEqual(expandPluginSlashCommand("/team-b:review", commands), "Team B review");
    assert.strictEqual(expandPluginSlashCommand("/unknown arg", commands), "/unknown arg");
    assert.strictEqual(
      expandPluginSlashCommand("not at start /standup", commands),
      "not at start /standup",
    );
    assert.strictEqual(expandPluginSlashCommand("/standup/path", commands), "/standup/path");
  });
});
