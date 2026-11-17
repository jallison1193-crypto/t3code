export const PROJECT_INSTRUCTIONS_MAX_BYTES = 16 * 1024;

export const PROJECT_INSTRUCTIONS_LEAD =
  "Instructions the user set for this project. Follow them unless the user says otherwise in this thread.";

export const PROJECT_INSTRUCTIONS_TRUNCATION_NOTE =
  "\n\n[Project instructions truncated at 16 KB limit.]";

export function formatProjectInstructions(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const prefix = `<project_instructions>\n${PROJECT_INSTRUCTIONS_LEAD}\n\n`;
  const suffix = "\n</project_instructions>";
  const full = `${prefix}${trimmed}${suffix}`;
  if (Buffer.byteLength(full, "utf8") <= PROJECT_INSTRUCTIONS_MAX_BYTES) {
    return full;
  }

  const maxBodyBytes =
    PROJECT_INSTRUCTIONS_MAX_BYTES -
    Buffer.byteLength(prefix, "utf8") -
    Buffer.byteLength(`${PROJECT_INSTRUCTIONS_TRUNCATION_NOTE}${suffix}`, "utf8");

  let usedBytes = 0;
  let end = 0;
  for (const ch of trimmed) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (usedBytes + chBytes > maxBodyBytes) break;
    usedBytes += chBytes;
    end += ch.length;
  }

  return `${prefix}${trimmed.slice(0, end)}${PROJECT_INSTRUCTIONS_TRUNCATION_NOTE}${suffix}`;
}
