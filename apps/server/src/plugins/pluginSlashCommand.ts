import type { PluginId } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Predicate from "effect/Predicate";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;
const SLASH_COMMAND_PATTERN =
  /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?::([a-z0-9]+(?:-[a-z0-9]+)*))?(?:[ \t]+([\s\S]*)|(\r?\n[\s\S]*)|$)/;
const SUBSTITUTION_PATTERN =
  /\$\{(CLAUDE_PLUGIN_ROOT|T3_PLUGIN_ROOT|CLAUDE_SKILL_DIR)\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)\b/g;

export interface ParsedPluginSkillMarkdown {
  readonly ok: true;
  readonly name?: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
  readonly body: string;
}

export interface PluginSkillMarkdownInput {
  readonly name: PluginId;
  readonly description?: string | undefined;
  readonly argumentHint?: string | undefined;
  readonly userInvocable?: boolean | undefined;
  readonly modelInvocable?: boolean | undefined;
  readonly body: string;
}

export interface PluginSlashCommandEntry {
  readonly pluginId: string;
  readonly name: string;
  readonly body: string;
  readonly pluginRoot: string;
  readonly skillDir: string;
}

/** Accepts YAML 1.1 booleans as Claude Code does. */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function stripLeadingBom(contents: string): string {
  return contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
}

function cleanBody(raw: string): string {
  return raw.replace(/^\r?\n+/, "").trimEnd();
}

function stripPluginSkillFrontmatter(contents: string): string {
  const normalized = stripLeadingBom(contents);
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (!match) return cleanBody(normalized);
  return cleanBody(normalized.slice(match[0].length));
}

export function parsePluginSkillMarkdown(
  contents: string,
): ParsedPluginSkillMarkdown | { readonly ok: false; readonly problem: string } {
  const normalized = stripLeadingBom(contents);
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (!match) {
    return {
      ok: true,
      userInvocable: true,
      modelInvocable: true,
      body: cleanBody(normalized),
    };
  }

  const frontmatterText = match[1] ?? "";
  let parsed: unknown;
  if (frontmatterText.trim().length === 0) {
    parsed = {};
  } else {
    try {
      parsed = parseYamlDocument(frontmatterText);
    } catch {
      const repaired = frontmatterText.replace(
        /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
        (line, prefix: string, value: string) => {
          const scalar = value.split(/[ \t]+#/)[0] ?? "";
          if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
            return line;
          }
          return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
        },
      );
      try {
        parsed = parseYamlDocument(repaired);
      } catch {
        return { ok: false, problem: "Frontmatter is not valid YAML." };
      }
    }
  }

  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (!Predicate.isObject(parsed) || Array.isArray(parsed)) {
    return { ok: false, problem: "Frontmatter must be a YAML mapping." };
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  const argumentHint =
    typeof parsed["argument-hint"] === "string" ? parsed["argument-hint"].trim() : "";
  const disableModelInvocation = parseFrontmatterBoolean(parsed["disable-model-invocation"]);
  const userInvocable = parseFrontmatterBoolean(parsed["user-invocable"]);

  return {
    ok: true,
    ...(name.length > 0 ? { name } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(argumentHint.length > 0 ? { argumentHint } : {}),
    userInvocable: userInvocable !== false,
    modelInvocable: disableModelInvocation !== true,
    body: cleanBody(normalized.slice(match[0].length)),
  };
}

export function formatPluginSkillMarkdown(skill: PluginSkillMarkdownInput): string {
  const lines = [`name: ${skill.name}`];
  const description = skill.description?.trim();
  if (description) {
    lines.push(`description: ${JSON.stringify(description)}`);
  }
  const argumentHint = skill.argumentHint?.trim();
  if (argumentHint) {
    lines.push(`argument-hint: ${JSON.stringify(argumentHint)}`);
  }
  if (skill.userInvocable === false) {
    lines.push("user-invocable: false");
  }
  if (skill.modelInvocable === false) {
    lines.push("disable-model-invocation: true");
  }
  const body = cleanBody(skill.body);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

export function expandPluginSlashCommand(
  text: string,
  commands: ReadonlyArray<PluginSlashCommandEntry>,
): string {
  if (commands.length === 0) return text;
  const match = SLASH_COMMAND_PATTERN.exec(text);
  if (!match) return text;

  const first = match[1];
  const second = match[2];
  if (first === undefined) return text;

  let target: PluginSlashCommandEntry | undefined;
  if (second !== undefined) {
    target = commands.find((entry) => entry.pluginId === first && entry.name === second);
  } else {
    const matches = commands.filter((entry) => entry.name === first);
    if (matches.length === 1) {
      target = matches[0];
    }
  }
  if (target === undefined) return text;

  const rawArgs = (match[3] ?? match[4] ?? "").trim();
  const argTokens = tokenizeCliArgs(rawArgs);
  const body = stripPluginSkillFrontmatter(target.body);
  let usedArguments = false;

  const expanded = body.replace(
    SUBSTITUTION_PATTERN,
    (
      _full,
      rootVar: string | undefined,
      bracketIndex: string | undefined,
      shortIndex: string | undefined,
    ) => {
      if (rootVar !== undefined) {
        return rootVar === "CLAUDE_SKILL_DIR" ? target.skillDir : target.pluginRoot;
      }
      usedArguments = true;
      if (bracketIndex !== undefined) {
        return argTokens[Number(bracketIndex)] ?? "";
      }
      if (shortIndex !== undefined) {
        return argTokens[Number(shortIndex)] ?? "";
      }
      return rawArgs;
    },
  );

  if (!usedArguments && rawArgs.length > 0) {
    return expanded.length > 0 ? `${expanded}\n\nARGUMENTS: ${rawArgs}` : `ARGUMENTS: ${rawArgs}`;
  }
  return expanded;
}
