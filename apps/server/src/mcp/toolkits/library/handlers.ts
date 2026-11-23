import {
  type OrchestrationV2ListHtmlLibraryResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HtmlLibrary from "../../../orchestration-v2/HtmlLibrary.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { LibraryToolkit } from "./tools.ts";

type LibraryEntry = OrchestrationV2ListHtmlLibraryResult["entries"][number];

const toLibraryPage = (entry: LibraryEntry) => ({
  title: entry.title,
  threadId: entry.threadId,
  threadTitle: entry.threadTitle,
  itemId: entry.itemId,
  projectId: entry.projectId,
  projectTitle: entry.projectTitle,
  pinned: entry.pinned,
  ...(entry.pinnedAt === undefined ? {} : { pinnedAt: entry.pinnedAt }),
  updatedAt: entry.updatedAt,
});

export const layer = McpToolAccess.toLayer(LibraryToolkit, {
  t3_library_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const library = yield* HtmlLibrary.HtmlLibrary;
      const { entries, hasMore } = yield* library
        .read({
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(Effect.mapError(unavailable));
      return {
        pages: entries.map(toLibraryPage),
        hasMore,
      };
    }),
  ),
  t3_library_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        yield* readCaller();
        const library = yield* HtmlLibrary.HtmlLibrary;
        const updated = yield* library
          .updateEntry({
            action: input.action,
            threadId: input.threadId,
            itemId: input.itemId,
            ...(input.title === undefined ? {} : { title: input.title }),
          })
          .pipe(
            Effect.catchTags({
              HtmlLibraryEntryNotFoundError: (error) =>
                Effect.fail(
                  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
                ),
              HtmlLibraryInvalidTitleError: (error) =>
                Effect.fail(
                  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
                ),
              ServerSettingsError: (error) =>
                Effect.fail(
                  error.operation === "write-managed-setting"
                    ? new OrchestratorMcpFailure({
                        code: "invalid_request",
                        message: error.message,
                      })
                    : unavailable(),
                ),
              SqlError: () => Effect.fail(unavailable()),
            }),
          );
        return { page: toLibraryPage(updated) };
      }),
  ),
});
