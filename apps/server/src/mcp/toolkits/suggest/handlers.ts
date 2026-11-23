import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { SuggestToolkit } from "./tools.ts";

const handlers = {
  t3_thread_suggest: McpToolAccess.actsAsCaller((input) =>
    Effect.succeed({
      suggestions: input.suggestions.map(({ title, prompt, reason }) => ({
        title,
        prompt,
        ...(reason === undefined ? {} : { reason }),
      })),
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof SuggestToolkit.tools>;

export const layer = McpToolAccess.toLayer(SuggestToolkit, handlers);
