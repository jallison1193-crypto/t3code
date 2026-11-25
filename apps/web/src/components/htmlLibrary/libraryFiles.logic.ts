import type {
  EnvironmentId,
  OrchestrationV2ListLibraryFilesInput,
  OrchestrationV2ListLibraryFilesResult,
  SidebarModeFilter,
} from "@t3tools/contracts";
import {
  fileDisplayName,
  isWindowsAbsolutePath,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

import { resolveDiffPathForWorkspace } from "~/diffFileActions";
import type { Source } from "./htmlLibraryPages";

export type LibraryView = "pages" | "files";

type Cursor = NonNullable<OrchestrationV2ListLibraryFilesInput["cursor"]>;

export type LibraryFileEntry = OrchestrationV2ListLibraryFilesResult["entries"][number] & {
  readonly environmentId: EnvironmentId;
};

interface Stream extends Source {
  readonly cursor: Cursor | null | undefined;
  readonly unavailable: boolean;
}

export interface LibraryFilesPages {
  readonly streams: readonly Stream[];
  readonly entries: readonly LibraryFileEntry[];
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePosition(a: Cursor, b: Cursor) {
  return compare(b.updatedAt, a.updatedAt) || compare(b.itemId, a.itemId);
}

export function libraryViewFromSearch(search: string | Record<string, unknown>): LibraryView {
  if (typeof search === "string") {
    return new URLSearchParams(search).get("view") === "files" ? "files" : "pages";
  }
  return search.view === "files" ? "files" : "pages";
}

export function libraryUrlWithView(
  pathname: string,
  searchStr: string,
  hash: string,
  view: LibraryView,
): string {
  const params = new URLSearchParams(searchStr);
  if (view === "files") {
    params.set("view", "files");
  } else {
    params.delete("view");
  }
  const query = params.toString();
  return `${pathname}${query.length > 0 ? `?${query}` : ""}${hash}`;
}

export function libraryFileEntryKey(
  entry: Pick<LibraryFileEntry, "environmentId" | "projectId" | "path">,
): string {
  const normalizedPath = isWindowsAbsolutePath(entry.path) ? entry.path.toLowerCase() : entry.path;
  return JSON.stringify([entry.environmentId, entry.projectId, normalizedPath]);
}

export function splitLibraryFilePath(
  filePath: string,
  workspaceRoot?: string | null,
): { readonly fileName: string; readonly parentFolder: string | null } {
  const fileName = fileDisplayName(filePath);
  const relative = workspaceRelativeFilePath(filePath, workspaceRoot);
  if (relative !== null && relative !== ".") {
    const slashIndex = relative.lastIndexOf("/");
    return {
      fileName,
      parentFolder: slashIndex > 0 ? relative.slice(0, slashIndex) : null,
    };
  }
  const trimmed = filePath.replace(/[/\\]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separatorIndex < 0) return { fileName, parentFolder: null };
  const dir = trimmed.slice(0, separatorIndex);
  if (dir.length === 0) return { fileName, parentFolder: trimmed.startsWith("/") ? "/" : null };
  if (/^[A-Za-z]:$/.test(dir)) {
    return { fileName, parentFolder: `${dir}${trimmed[separatorIndex] ?? "\\"}` };
  }
  return { fileName, parentFolder: dir };
}

export function libraryFileOpenPath(
  entry: Pick<LibraryFileEntry, "path" | "workspaceRoot">,
  fallbackWorkspaceRoot?: string | null,
): string | null {
  const workspaceRoot = entry.workspaceRoot ?? fallbackWorkspaceRoot ?? undefined;
  return resolveDiffPathForWorkspace({
    filePath: entry.path,
    workspaceRoot,
    repositoryRoot: undefined,
  });
}

export function startLibraryFiles(sources: readonly Source[]): LibraryFilesPages {
  return {
    streams: sources.map((source) => ({ ...source, cursor: undefined, unavailable: false })),
    entries: [],
  };
}

export function libraryFilesView(pages: LibraryFilesPages) {
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

const MAX_EMPTY_FILE_SEARCH_BATCHES = 5;

function sameCursor(a: Cursor | null | undefined, b: Cursor | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return a.updatedAt === b.updatedAt && a.itemId === b.itemId;
}

async function loadLibraryFilesBatch(
  pages: LibraryFilesPages,
  mode: SidebarModeFilter,
  readPage: (
    environmentId: EnvironmentId,
    input: OrchestrationV2ListLibraryFilesInput,
  ) => Promise<OrchestrationV2ListLibraryFilesResult>,
): Promise<LibraryFilesPages> {
  const results = await Promise.all(
    pages.streams.map(async (stream) => {
      if (stream.cursor === null) return { stream, entries: [] };
      try {
        const page = await readPage(stream.environmentId, {
          mode,
          ...(stream.projectIds === undefined ? {} : { projectIds: stream.projectIds }),
          ...(stream.cursor === undefined ? {} : { cursor: stream.cursor }),
        });
        const nextCursor = sameCursor(stream.cursor, page.nextCursor) ? null : page.nextCursor;
        return {
          stream: { ...stream, cursor: nextCursor },
          entries: page.entries.map((entry) => ({ ...entry, environmentId: stream.environmentId })),
        };
      } catch {
        return { stream: { ...stream, cursor: null, unavailable: true }, entries: [] };
      }
    }),
  );
  const entries = [...pages.entries, ...results.flatMap((result) => result.entries)].sort(
    (a, b) =>
      comparePosition(a, b) || compare(a.environmentId, b.environmentId) || compare(a.path, b.path),
  );
  const seen = new Set<string>();
  return {
    streams: results.map((result) => result.stream),
    entries: entries.filter((entry) => {
      const key = libraryFileEntryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export async function loadLibraryFiles(
  pages: LibraryFilesPages,
  mode: SidebarModeFilter,
  readPage: (
    environmentId: EnvironmentId,
    input: OrchestrationV2ListLibraryFilesInput,
  ) => Promise<OrchestrationV2ListLibraryFilesResult>,
  options?: {
    readonly maxEmptyBatches?: number;
    readonly signal?: AbortSignal;
  },
): Promise<LibraryFilesPages> {
  const maxBatches = Math.max(1, options?.maxEmptyBatches ?? MAX_EMPTY_FILE_SEARCH_BATCHES);
  const initialVisibleCount = libraryFilesView(pages).entries.length;
  let current = pages;
  for (let batch = 0; batch < maxBatches; batch++) {
    if (options?.signal?.aborted) break;
    current = await loadLibraryFilesBatch(current, mode, readPage);
    const view = libraryFilesView(current);
    if (view.entries.length > initialVisibleCount || !view.hasMore) break;
  }
  return current;
}
