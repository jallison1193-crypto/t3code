import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

export interface NewBotDialogRequest {
  readonly environmentId?: EnvironmentId;
}

export const useNewBotDialog = create<{ request: NewBotDialogRequest | null }>(() => ({
  request: null,
}));

export function openNewBotDialog(request: NewBotDialogRequest = {}) {
  useNewBotDialog.setState({ request });
}

export function closeNewBotDialog() {
  useNewBotDialog.setState({ request: null });
}
