import { resolveSidebarModeFilter } from "@t3tools/contracts";
import type { SidebarModeFilter as SidebarModeFilterValue } from "@t3tools/contracts/settings";
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
  activeMode,
  onModeSelect,
}: {
  readonly label: string;
  readonly includeBots?: boolean;
  readonly activeMode?: SidebarModeFilterValue;
  readonly onModeSelect?: (mode: SidebarModeFilterValue) => void;
}) {
  const m = useMessages();
  const botsEnabled = useAnyBotsEnabled();
  const showBots = includeBots && botsEnabled;
  const options = showBots ? [...BASE_OPTIONS, BOTS_OPTION] : BASE_OPTIONS;
  const savedMode = useClientSettings((settings) => settings.sidebarModeFilter);
  const effectiveMode = resolveSidebarModeFilter(activeMode ?? savedMode, showBots);
  return (
    <ToggleGroup
      aria-label={label}
      variant="segmented"
      size="segmented"
      value={[effectiveMode]}
      onValueChange={(next) => {
        const option = options.find(({ value }) => value !== effectiveMode && next.includes(value));
        if (option) {
          onModeSelect?.(option.value);
          void persistClientSettingsPatch({ sidebarModeFilter: option.value });
        }
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
