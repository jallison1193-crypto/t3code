import type { ScopedThreadRef } from "@t3tools/contracts";

import { isElectron } from "../env";

/**
 * True in the desktop companion window, which the shell opens on the companion route. It shares
 * the main window's origin and storage, so app-wide services and saved state stay with that one.
 */
export const isCompanionWindow = isElectron && window.location.hash.startsWith("#/companion/");

/** Whether to offer "Open companion window": a desktop shell that has it, with it turned on. */
export function canOpenCompanionWindow(companionWindowEnabled: boolean): boolean {
  return (
    companionWindowEnabled && !isCompanionWindow && window.desktopBridge?.companion !== undefined
  );
}

export function openCompanionWindow(threadRef: ScopedThreadRef): void {
  void window.desktopBridge?.companion?.open(threadRef);
}
