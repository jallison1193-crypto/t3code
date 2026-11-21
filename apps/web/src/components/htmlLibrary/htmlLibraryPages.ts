import type {
  EnvironmentId,
  OrchestrationV2ListHtmlLibraryInput,
  OrchestrationV2ListHtmlLibraryResult,
  ProjectId,
  SidebarModeFilter,
} from "@t3tools/contracts";

type Cursor = NonNullable<OrchestrationV2ListHtmlLibraryInput["cursor"]>;

export type HtmlLibraryEntry = OrchestrationV2ListHtmlLibraryResult["entries"][number] & {
  readonly environmentId: EnvironmentId;
};

interface Source {
  readonly environmentId: EnvironmentId;
  readonly projectIds?: readonly ProjectId[];
}

interface Stream extends Source {
  readonly cursor: Cursor | null | undefined;
  readonly unavailable: boolean;
}

interface LibraryPages {
  readonly streams: readonly Stream[];
  readonly entries: readonly HtmlLibraryEntry[];
}

export function librarySources(
  members: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[],
): Source[] {
  const byEnvironment = new Map<EnvironmentId, Set<ProjectId>>();
  for (const member of members) {
    const ids = byEnvironment.get(member.environmentId) ?? new Set<ProjectId>();
    ids.add(member.id);
    byEnvironment.set(member.environmentId, ids);
  }
  const sources: Source[] = [];
  for (const [environmentId, ids] of [...byEnvironment].sort(([a], [b]) => compare(a, b))) {
    const projectIds = [...ids].sort();
    for (let start = 0; start < projectIds.length; start += 100) {
      sources.push({ environmentId, projectIds: projectIds.slice(start, start + 100) });
    }
  }
  return sources;
}

export function startLibrary(sources: readonly Source[]): LibraryPages {
  return {
    streams: sources.map((source) => ({ ...source, cursor: undefined, unavailable: false })),
    entries: [],
  };
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePosition(a: Cursor, b: Cursor) {
  return compare(b.updatedAt, a.updatedAt) || compare(b.itemId, a.itemId);
}

export function libraryEntryKey(entry: HtmlLibraryEntry) {
  return JSON.stringify([entry.environmentId, entry.attachmentId]);
}

export function libraryPageView(pages: LibraryPages) {
  const active = pages.streams.filter(({ cursor }) => cursor !== null);
  // A sparse page still advances past its cursor. Beyond the newest cursor, an
  // unseen result could sort before a loaded row, so keep that row buffered.
  const frontier = active.flatMap(({ cursor }) => cursor ?? []).sort(comparePosition)[0];
  return {
    entries:
      frontier === undefined
        ? pages.entries
        : pages.entries.filter((entry) => comparePosition(entry, frontier) <= 0),
    hasMore: active.length > 0,
    unavailable: [
      ...new Set(pages.streams.filter((s) => s.unavailable).map((s) => s.environmentId)),
    ],
  };
}

export async function loadLibraryPages(
  pages: LibraryPages,
  mode: SidebarModeFilter,
  readPage: (
    environmentId: EnvironmentId,
    input: OrchestrationV2ListHtmlLibraryInput,
  ) => Promise<OrchestrationV2ListHtmlLibraryResult>,
): Promise<LibraryPages> {
  const results = await Promise.all(
    pages.streams.map(async (stream) => {
      if (stream.cursor === null) return { stream, entries: [] };
      try {
        const page = await readPage(stream.environmentId, {
          mode,
          ...(stream.projectIds === undefined ? {} : { projectIds: stream.projectIds }),
          ...(stream.cursor === undefined ? {} : { cursor: stream.cursor }),
        });
        return {
          stream: { ...stream, cursor: page.nextCursor },
          entries: page.entries.map((entry) => ({ ...entry, environmentId: stream.environmentId })),
        };
      } catch {
        return { stream: { ...stream, cursor: null, unavailable: true }, entries: [] };
      }
    }),
  );
  const entries = [...pages.entries, ...results.flatMap((result) => result.entries)].sort(
    (a, b) => comparePosition(a, b) || compare(a.environmentId, b.environmentId),
  );
  const seen = new Set<string>();
  return {
    streams: results.map((result) => result.stream),
    entries: entries.filter((entry) => {
      const key = libraryEntryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}
