import type { ScopedProjectRef } from "@t3tools/contracts";
import type { ThreadSuggestion } from "@t3tools/shared/toolOutput";
import { T } from "gt-react";
import { useId } from "react";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { Button } from "../ui/button";

function promptPreview(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function keyedSuggestions(suggestions: ReadonlyArray<ThreadSuggestion>) {
  const seen = new Map<string, number>();
  return suggestions.map((suggestion) => {
    const base = `${suggestion.title}\0${suggestion.prompt}\0${suggestion.reason ?? ""}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      key: count === 0 ? base : `${base}\0${count}`,
      suggestion,
    };
  });
}

function StartSuggestedThreadButton({
  projectRef,
  prompt,
}: {
  readonly projectRef: ScopedProjectRef;
  readonly prompt: string;
}) {
  const handleNewThread = useNewThreadHandler();
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => {
        void handleNewThread(projectRef, { prompt });
      }}
    >
      <T>Start</T>
    </Button>
  );
}

export function ThreadSuggestionsCard({
  suggestions,
  projectRef,
}: {
  readonly suggestions: ReadonlyArray<ThreadSuggestion>;
  readonly projectRef: ScopedProjectRef | null;
}) {
  const headingId = useId();
  const items = keyedSuggestions(suggestions);

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border/80 bg-card/70">
      <div className="border-b border-border/60 px-3 py-2">
        <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
          <T>Suggested threads</T>
        </h3>
      </div>
      <ul className="divide-y divide-border/60">
        {items.map(({ key, suggestion }) => (
          <li key={key} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="truncate text-sm font-medium text-foreground">{suggestion.title}</div>
              {suggestion.reason ? (
                <p className="truncate text-xs text-muted-foreground">{suggestion.reason}</p>
              ) : null}
              <p className="truncate text-xs text-muted-foreground/80">
                {promptPreview(suggestion.prompt)}
              </p>
            </div>
            {projectRef ? (
              <StartSuggestedThreadButton projectRef={projectRef} prompt={suggestion.prompt} />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
