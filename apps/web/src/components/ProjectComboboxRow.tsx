import type { ReactNode } from "react";

/** Home and settings show only on the highlighted row; the pin keeps the far-right column. */
export function ProjectRowActions(props: {
  readonly home?: ReactNode;
  readonly settings?: ReactNode;
  readonly pin?: ReactNode;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center pointer-coarse:gap-1">
      {props.home || props.settings ? (
        <span className="flex pointer-coarse:gap-1 pointer-fine:invisible pointer-fine:in-data-highlighted:visible">
          {props.home}
          {props.settings}
        </span>
      ) : null}
      {props.pin ?? <span className="size-7 sm:size-6" />}
    </span>
  );
}
