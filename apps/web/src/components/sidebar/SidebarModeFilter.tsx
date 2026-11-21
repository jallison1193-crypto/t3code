import { msg, useMessages } from "gt-react";

import { persistClientSettingsPatch, useClientSettings } from "~/hooks/useSettings";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const OPTIONS = [
  { value: "all", label: msg("All") },
  { value: "code", label: msg("Code") },
  { value: "work", label: msg("Work") },
] as const;

export function SidebarModeFilter({ label }: { readonly label: string }) {
  const m = useMessages();
  const mode = useClientSettings((settings) => settings.sidebarModeFilter);
  return (
    <ToggleGroup
      aria-label={label}
      variant="segmented"
      size="segmented"
      value={[mode]}
      onValueChange={(next) => {
        const option = OPTIONS.find(({ value }) => value !== mode && next.includes(value));
        if (option) void persistClientSettingsPatch({ sidebarModeFilter: option.value });
      }}
    >
      {OPTIONS.map(({ value, label }) => (
        <Toggle key={value} value={value}>
          {m(label)}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
