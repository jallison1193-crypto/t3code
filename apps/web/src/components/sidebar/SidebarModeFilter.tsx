import { resolveSidebarModeFilter } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import { useAnyBotsEnabled } from "~/bots/useBots";
import { persistClientSettingsPatch, useClientSettings } from "~/hooks/useSettings";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const BASE_OPTIONS = [
  { value: "all", label: msg("All") },
  { value: "code", label: msg("Code") },
  { value: "work", label: msg("Work") },
] as const;

const BOTS_OPTION = { value: "bots", label: msg("Bots") } as const;

export function SidebarModeFilter({
  label,
  includeBots = true,
}: {
  readonly label: string;
  readonly includeBots?: boolean;
}) {
  const m = useMessages();
  const botsEnabled = useAnyBotsEnabled();
  const showBots = includeBots && botsEnabled;
  const options = showBots ? [...BASE_OPTIONS, BOTS_OPTION] : BASE_OPTIONS;
  const savedMode = useClientSettings((settings) => settings.sidebarModeFilter);
  const effectiveMode = resolveSidebarModeFilter(savedMode, showBots);
  return (
    <ToggleGroup
      aria-label={label}
      variant="segmented"
      size="segmented"
      value={[effectiveMode]}
      onValueChange={(next) => {
        const option = options.find(({ value }) => value !== effectiveMode && next.includes(value));
        if (option) void persistClientSettingsPatch({ sidebarModeFilter: option.value });
      }}
    >
      {options.map(({ value, label }) => (
        <Toggle key={value} value={value}>
          {m(label)}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
