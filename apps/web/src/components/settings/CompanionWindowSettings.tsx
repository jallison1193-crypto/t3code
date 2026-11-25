import {
  CompanionWindowPosition,
  CompanionWindowSize,
  DEFAULT_UNIFIED_SETTINGS,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const POSITION_LABELS: Record<CompanionWindowPosition, string> = {
  right: msg("Right side"),
  "bottom-right": msg("Bottom right"),
  "bottom-left": msg("Bottom left"),
  left: msg("Left side"),
};

const SIZE_LABELS: Record<CompanionWindowSize, string> = {
  small: msg("Small"),
  medium: msg("Medium"),
  large: msg("Large"),
};

const isPosition = Schema.is(CompanionWindowPosition);
const isSize = Schema.is(CompanionWindowSize);

/** Desktop only: the small window that follows a thread. */
export function CompanionWindowSettings() {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsSection id="companion-window-settings" title={gt("Companion window")}>
      <SettingsRow
        {...setting("companion-window")}
        description={
          <T>A small window that follows a thread. On Windows, screenshots leave it out.</T>
        }
        resetAction={
          settings.companionWindowEnabled !== DEFAULT_UNIFIED_SETTINGS.companionWindowEnabled ? (
            <SettingResetButton
              ariaLabel={gt("Reset companion window to default")}
              onClick={() =>
                updateSettings({
                  companionWindowEnabled: DEFAULT_UNIFIED_SETTINGS.companionWindowEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.companionWindowEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ companionWindowEnabled: Boolean(checked) })
            }
            aria-label={gt("Enable the companion window")}
          />
        }
      />
      <SettingsRow
        {...setting("companion-window-on-top")}
        description={<T>Keep it above other windows.</T>}
        resetAction={
          settings.companionWindowAlwaysOnTop !==
          DEFAULT_UNIFIED_SETTINGS.companionWindowAlwaysOnTop ? (
            <SettingResetButton
              ariaLabel={gt("Reset always on top to default")}
              onClick={() =>
                updateSettings({
                  companionWindowAlwaysOnTop: DEFAULT_UNIFIED_SETTINGS.companionWindowAlwaysOnTop,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.companionWindowAlwaysOnTop}
            onCheckedChange={(checked) =>
              updateSettings({ companionWindowAlwaysOnTop: Boolean(checked) })
            }
            aria-label={gt("Keep the companion window on top")}
          />
        }
      />
      <SettingsRow
        {...setting("companion-window-position")}
        description={<T>Where it opens on the screen.</T>}
        resetAction={
          settings.companionWindowPosition !== DEFAULT_UNIFIED_SETTINGS.companionWindowPosition ? (
            <SettingResetButton
              ariaLabel={gt("Reset companion window position to default")}
              onClick={() =>
                updateSettings({
                  companionWindowPosition: DEFAULT_UNIFIED_SETTINGS.companionWindowPosition,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.companionWindowPosition}
            onValueChange={(value) => {
              if (isPosition(value)) updateSettings({ companionWindowPosition: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={gt("Companion window position")}
            >
              <SelectValue>{m(POSITION_LABELS[settings.companionWindowPosition])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(POSITION_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {m(label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...setting("companion-window-size")}
        description={<T>Small is a status bubble, large is the full thread.</T>}
        resetAction={
          settings.companionWindowSize !== DEFAULT_UNIFIED_SETTINGS.companionWindowSize ? (
            <SettingResetButton
              ariaLabel={gt("Reset companion window size to default")}
              onClick={() =>
                updateSettings({
                  companionWindowSize: DEFAULT_UNIFIED_SETTINGS.companionWindowSize,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.companionWindowSize}
            onValueChange={(value) => {
              if (isSize(value)) updateSettings({ companionWindowSize: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={gt("Companion window size")}
            >
              <SelectValue>{m(SIZE_LABELS[settings.companionWindowSize])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(SIZE_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {m(label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...setting("companion-window-auto-open")}
        description={
          <T>Opens it on the thread whose agent is using this computer, without taking focus.</T>
        }
        resetAction={
          settings.companionWindowAutoOpen !== DEFAULT_UNIFIED_SETTINGS.companionWindowAutoOpen ? (
            <SettingResetButton
              ariaLabel={gt("Reset open during computer use to default")}
              onClick={() =>
                updateSettings({
                  companionWindowAutoOpen: DEFAULT_UNIFIED_SETTINGS.companionWindowAutoOpen,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.companionWindowAutoOpen}
            onCheckedChange={(checked) =>
              updateSettings({ companionWindowAutoOpen: Boolean(checked) })
            }
            aria-label={gt("Open the companion window during computer use")}
          />
        }
      />
      <SettingsRow
        {...setting("companion-window-auto-hide")}
        description={<T>Closes it a few seconds after the agent stops, if it opened by itself.</T>}
        resetAction={
          settings.companionWindowAutoHide !== DEFAULT_UNIFIED_SETTINGS.companionWindowAutoHide ? (
            <SettingResetButton
              ariaLabel={gt("Reset hide after computer use to default")}
              onClick={() =>
                updateSettings({
                  companionWindowAutoHide: DEFAULT_UNIFIED_SETTINGS.companionWindowAutoHide,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.companionWindowAutoHide}
            onCheckedChange={(checked) =>
              updateSettings({ companionWindowAutoHide: Boolean(checked) })
            }
            aria-label={gt("Hide the companion window after computer use")}
          />
        }
      />
      <SettingsRow
        {...setting("companion-window-click-through")}
        description={
          <T>Clicks pass through it to the app underneath while an agent uses the computer.</T>
        }
        resetAction={
          settings.companionWindowClickThrough !==
          DEFAULT_UNIFIED_SETTINGS.companionWindowClickThrough ? (
            <SettingResetButton
              ariaLabel={gt("Reset click-through during computer use to default")}
              onClick={() =>
                updateSettings({
                  companionWindowClickThrough: DEFAULT_UNIFIED_SETTINGS.companionWindowClickThrough,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.companionWindowClickThrough}
            onCheckedChange={(checked) =>
              updateSettings({ companionWindowClickThrough: Boolean(checked) })
            }
            aria-label={gt("Click through the companion window during computer use")}
          />
        }
      />
    </SettingsSection>
  );
}
