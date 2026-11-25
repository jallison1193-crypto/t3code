import type { RuntimeMode } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { memo, useRef } from "react";
import { EllipsisIcon, ShieldCheckIcon } from "lucide-react";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showPermissions: boolean;
  isBotThread?: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={size}
            className="shrink-0"
            aria-label={gt("More composer controls")}
            data-composer-shortcut={
              props.showPermissions && !props.isBotThread ? "composer.mode" : undefined
            }
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.showPermissions ? (
          props.isBotThread ? (
            <div className="grid w-72 gap-1 px-2 py-1.5">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <ShieldCheckIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <T>Bot safety gate</T>
              </div>
              <p className="text-xs leading-4 text-muted-foreground">
                <T>Bots always ask before sending, deleting, or changing agent settings.</T>
              </p>
            </div>
          ) : (
            <ComposerPermissionsSection
              runtimeMode={props.runtimeMode}
              runtimeModeOptions={props.runtimeModeOptions}
              onRuntimeModeChange={props.onRuntimeModeChange}
            />
          )
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
