export const PROJECT_INSTRUCTIONS_MAX_BYTES = 16 * 1024;
export const PROJECT_MEMORY_HEAD_MAX_BYTES = 2 * 1024;
export const PROJECT_KNOWLEDGE_LIST_MAX_BYTES = 1 * 1024;
export const PLUGIN_INSTRUCTIONS_SECTION_MAX_BYTES = 6 * 1024;
export const PLUGIN_SKILLS_LIST_MAX_BYTES = 2 * 1024;

export const PROJECT_INSTRUCTIONS_LEAD =
  "Instructions the user set for this project. Follow them unless the user says otherwise in this thread.";

export const PROJECT_INSTRUCTIONS_TRUNCATION_NOTE =
  "\n\n[Project instructions truncated at 16 KB limit.]";

export const COORDINATOR_INSTRUCTIONS_LEAD =
  "You are this project's coordinator thread. Keep the plan and status current in project memory. Hand work to new threads with t3_thread_launch and pass notifyOnFinish: true; you will get a message when each one finishes. Review their results before starting the next step.";

export const COORDINATOR_INSTRUCTIONS_TRUNCATION_NOTE =
  "\n\n[Coordinator instructions truncated at 16 KB limit.]";

export const PROJECT_MEMORY_TOOLS_NOTE =
  "Full memory and knowledge files are available through the `t3_project_memory_*` and `t3_project_knowledge_*` tools when T3 tools are available.";

export const PROJECT_MEMORY_TRUNCATION_NOTE = "\n\n[Memory preview truncated at 2 KB.]";

export const PROJECT_KNOWLEDGE_TRUNCATION_NOTE =
  "- ... (more files available via t3_project_knowledge_list)";

export const PLUGIN_INSTRUCTIONS_TRUNCATION_NOTE =
  "\n\n[Plugin instructions truncated at 6 KB limit.]";

export const PLUGIN_SKILLS_TRUNCATION_NOTE = "- ... (more plugin skills omitted at 2 KB limit)";

export interface ProjectContextPluginSkill {
  readonly name: string;
  readonly description?: string | undefined;
  readonly path: string;
}

export interface ProjectContextPlugin {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly instructions?: string | undefined;
  readonly skills?: ReadonlyArray<ProjectContextPluginSkill> | undefined;
}

export interface ProjectContextInput {
  readonly instructions?: string | undefined;
  /** Present only for the project's coordinator thread. */
  readonly coordinator?: { readonly instructions?: string | undefined } | undefined;
  readonly memoryHead?: string | undefined;
  readonly knowledgeFiles?: ReadonlyArray<string> | undefined;
  readonly plugins?: ReadonlyArray<ProjectContextPlugin> | undefined;
}

function truncateUtf8ToBytes(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  let usedBytes = 0;
  let end = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (usedBytes + chBytes > maxBytes) break;
    usedBytes += chBytes;
    end += ch.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

function formatBudgetedLines(
  entries: ReadonlyArray<string>,
  maxListBytes: number,
  truncationNote: string,
): string | undefined {
  if (entries.length === 0 || maxListBytes <= 0) return undefined;
  const noteBytes = Buffer.byteLength(truncationNote, "utf8");
  const lines: Array<string> = [];
  let usedBytes = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const line = `- ${entries[i]}`;
    const prefixBytes = lines.length === 0 ? 0 : 1; // "\n"
    const lineBytes = Buffer.byteLength(line, "utf8");
    const hasMore = i + 1 < entries.length;
    const reservedForNote = hasMore ? 1 + noteBytes : 0;

    if (usedBytes + prefixBytes + lineBytes + reservedForNote <= maxListBytes) {
      lines.push(line);
      usedBytes += prefixBytes + lineBytes;
      continue;
    }

    if (lines.length === 0 && !hasMore && usedBytes + lineBytes <= maxListBytes) {
      lines.push(line);
      usedBytes += lineBytes;
    } else if (usedBytes + (lines.length === 0 ? 0 : 1) + noteBytes <= maxListBytes) {
      lines.push(truncationNote);
    }
    break;
  }

  return lines.length === 0 ? undefined : lines.join("\n");
}

function collectPluginSections(plugins: ReadonlyArray<ProjectContextPlugin> | undefined): {
  readonly instructionsBody: string;
  readonly skillEntries: ReadonlyArray<string>;
} {
  if (plugins === undefined || plugins.length === 0) {
    return { instructionsBody: "", skillEntries: [] };
  }
  const instructionBlocks: Array<string> = [];
  const rawSkills: Array<{
    readonly pluginId: string;
    readonly name: string;
    readonly description?: string | undefined;
    readonly path: string;
  }> = [];
  const skillNameCounts = new Map<string, number>();

  for (const plugin of plugins) {
    const trimmed = plugin.instructions?.trim() ?? "";
    if (trimmed.length > 0) {
      const heading = plugin.displayName?.trim() || plugin.id;
      instructionBlocks.push(`### ${heading}\n\n${trimmed}`);
    }
    for (const skill of plugin.skills ?? []) {
      const name = skill.name.trim();
      const path = skill.path.trim();
      if (name.length === 0 || path.length === 0) continue;
      skillNameCounts.set(name, (skillNameCounts.get(name) ?? 0) + 1);
      rawSkills.push({
        pluginId: plugin.id,
        name,
        description: skill.description?.trim() || undefined,
        path,
      });
    }
  }

  const skillEntries = rawSkills.map((skill) => {
    const label =
      (skillNameCounts.get(skill.name) ?? 0) > 1 ? `${skill.pluginId}:${skill.name}` : skill.name;
    return skill.description !== undefined
      ? `${label}: ${skill.description} (read ${skill.path} when relevant)`
      : `${label} (read ${skill.path} when relevant)`;
  });

  return {
    instructionsBody: instructionBlocks.join("\n\n"),
    skillEntries,
  };
}

export function formatProjectContext(input: ProjectContextInput): string | undefined {
  const trimmedInstructions = input.instructions?.trim() ?? "";
  const trimmedCoordinatorInstructions = input.coordinator?.instructions?.trim() ?? "";
  const trimmedMemory = input.memoryHead?.trim() ?? "";
  const cleanedKnowledge = (input.knowledgeFiles ?? [])
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  const { instructionsBody: pluginInstructionsBody, skillEntries: pluginSkillEntries } =
    collectPluginSections(input.plugins);

  if (
    trimmedInstructions.length === 0 &&
    input.coordinator === undefined &&
    trimmedMemory.length === 0 &&
    cleanedKnowledge.length === 0 &&
    pluginInstructionsBody.length === 0 &&
    pluginSkillEntries.length === 0
  ) {
    return undefined;
  }

  const envelopePrefix = "<project_instructions>\n";
  const envelopeSuffix = "\n</project_instructions>";
  let remainingBytes =
    PROJECT_INSTRUCTIONS_MAX_BYTES -
    Buffer.byteLength(envelopePrefix, "utf8") -
    Buffer.byteLength(envelopeSuffix, "utf8");

  const sections: Array<string> = [];

  if (trimmedInstructions.length > 0) {
    const lead = `${PROJECT_INSTRUCTIONS_LEAD}\n\n`;
    const fullSection = `${lead}${trimmedInstructions}`;
    const fullBytes = Buffer.byteLength(fullSection, "utf8");
    if (fullBytes <= remainingBytes) {
      sections.push(fullSection);
      remainingBytes -= fullBytes;
    } else {
      const overheadBytes =
        Buffer.byteLength(lead, "utf8") +
        Buffer.byteLength(PROJECT_INSTRUCTIONS_TRUNCATION_NOTE, "utf8");
      const truncated = truncateUtf8ToBytes(trimmedInstructions, remainingBytes - overheadBytes);
      sections.push(`${lead}${truncated.text}${PROJECT_INSTRUCTIONS_TRUNCATION_NOTE}`);
      remainingBytes = 0;
    }
  }

  if (input.coordinator !== undefined && remainingBytes > 0) {
    const sepBytes = sections.length === 0 ? 0 : 2; // "\n\n"
    const header = `## Coordinator\n\n${COORDINATOR_INSTRUCTIONS_LEAD}\n\n`;
    const fullSection =
      trimmedCoordinatorInstructions.length === 0
        ? header.trimEnd()
        : `${header}${trimmedCoordinatorInstructions}`;
    const fullBytes = sepBytes + Buffer.byteLength(fullSection, "utf8");
    if (fullBytes <= remainingBytes) {
      sections.push(fullSection);
      remainingBytes -= fullBytes;
    } else {
      const overheadBytes =
        sepBytes +
        Buffer.byteLength(header, "utf8") +
        Buffer.byteLength(COORDINATOR_INSTRUCTIONS_TRUNCATION_NOTE, "utf8");
      if (remainingBytes > overheadBytes) {
        const truncated = truncateUtf8ToBytes(
          trimmedCoordinatorInstructions,
          remainingBytes - overheadBytes,
        );
        if (truncated.text.length > 0) {
          sections.push(`${header}${truncated.text}${COORDINATOR_INSTRUCTIONS_TRUNCATION_NOTE}`);
          remainingBytes = 0;
        }
      }
    }
  }

  let includedToolsNote = false;

  if (trimmedMemory.length > 0 && remainingBytes > 0) {
    const sepBytes = sections.length === 0 ? 0 : 2; // "\n\n"
    const memoryHeader = "## Project memory\n\n";
    const memoryFooter = `\n\n${PROJECT_MEMORY_TOOLS_NOTE}`;
    const wrapperBytes =
      sepBytes + Buffer.byteLength(memoryHeader, "utf8") + Buffer.byteLength(memoryFooter, "utf8");
    const maxBodyBudget = Math.min(PROJECT_MEMORY_HEAD_MAX_BYTES, remainingBytes - wrapperBytes);
    if (maxBodyBudget > 0) {
      const noteBytes = Buffer.byteLength(PROJECT_MEMORY_TRUNCATION_NOTE, "utf8");
      let memoryBody: string | undefined;
      if (Buffer.byteLength(trimmedMemory, "utf8") <= maxBodyBudget) {
        memoryBody = trimmedMemory;
      } else if (maxBodyBudget > noteBytes) {
        const truncated = truncateUtf8ToBytes(trimmedMemory, maxBodyBudget - noteBytes);
        if (truncated.text.length > 0) {
          memoryBody = `${truncated.text}${PROJECT_MEMORY_TRUNCATION_NOTE}`;
        }
      }
      if (memoryBody !== undefined) {
        const section = `${memoryHeader}${memoryBody}${memoryFooter}`;
        sections.push(section);
        remainingBytes -= sepBytes + Buffer.byteLength(section, "utf8");
        includedToolsNote = true;
      }
    }
  }

  if (cleanedKnowledge.length > 0 && remainingBytes > 0) {
    const sepBytes = sections.length === 0 ? 0 : 2; // "\n\n"
    const knowledgeHeader = includedToolsNote
      ? "## Project knowledge\n\n"
      : `## Project knowledge\n\n${PROJECT_MEMORY_TOOLS_NOTE}\n\n`;
    const headerBytes = sepBytes + Buffer.byteLength(knowledgeHeader, "utf8");
    const listBudget = Math.min(PROJECT_KNOWLEDGE_LIST_MAX_BYTES, remainingBytes - headerBytes);
    const listText = formatBudgetedLines(
      cleanedKnowledge,
      listBudget,
      PROJECT_KNOWLEDGE_TRUNCATION_NOTE,
    );
    if (listText !== undefined) {
      const section = `${knowledgeHeader}${listText}`;
      sections.push(section);
      remainingBytes -= sepBytes + Buffer.byteLength(section, "utf8");
    }
  }

  if (pluginInstructionsBody.length > 0 && remainingBytes > 0) {
    const sepBytes = sections.length === 0 ? 0 : 2; // "\n\n"
    const header = "## Plugin instructions\n\n";
    const headerBytes = sepBytes + Buffer.byteLength(header, "utf8");
    const maxBodyBudget = Math.min(
      PLUGIN_INSTRUCTIONS_SECTION_MAX_BYTES,
      remainingBytes - headerBytes,
    );
    if (maxBodyBudget > 0) {
      const noteBytes = Buffer.byteLength(PLUGIN_INSTRUCTIONS_TRUNCATION_NOTE, "utf8");
      let body: string | undefined;
      if (Buffer.byteLength(pluginInstructionsBody, "utf8") <= maxBodyBudget) {
        body = pluginInstructionsBody;
      } else if (maxBodyBudget > noteBytes) {
        const truncated = truncateUtf8ToBytes(pluginInstructionsBody, maxBodyBudget - noteBytes);
        if (truncated.text.length > 0) {
          body = `${truncated.text}${PLUGIN_INSTRUCTIONS_TRUNCATION_NOTE}`;
        }
      }
      if (body !== undefined) {
        const section = `${header}${body}`;
        sections.push(section);
        remainingBytes -= sepBytes + Buffer.byteLength(section, "utf8");
      }
    }
  }

  if (pluginSkillEntries.length > 0 && remainingBytes > 0) {
    const sepBytes = sections.length === 0 ? 0 : 2; // "\n\n"
    const header = "## Plugin skills\n\n";
    const headerBytes = sepBytes + Buffer.byteLength(header, "utf8");
    const listBudget = Math.min(PLUGIN_SKILLS_LIST_MAX_BYTES, remainingBytes - headerBytes);
    const listText = formatBudgetedLines(
      pluginSkillEntries,
      listBudget,
      PLUGIN_SKILLS_TRUNCATION_NOTE,
    );
    if (listText !== undefined) {
      const section = `${header}${listText}`;
      sections.push(section);
      remainingBytes -= sepBytes + Buffer.byteLength(section, "utf8");
    }
  }

  if (sections.length === 0) return undefined;
  return `${envelopePrefix}${sections.join("\n\n")}${envelopeSuffix}`;
}

export function formatProjectInstructions(raw: string | undefined): string | undefined {
  return formatProjectContext({ instructions: raw });
}
