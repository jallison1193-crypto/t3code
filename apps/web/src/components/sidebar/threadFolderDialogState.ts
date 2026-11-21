import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadSectionId } from "@t3tools/contracts/settings";
import { create } from "zustand";

export type ThreadFolderDialogRequest =
  | { readonly kind: "create" }
  | {
      readonly kind: "rename" | "delete";
      readonly homeId: EnvironmentId;
      readonly sectionId: ThreadSectionId;
      readonly name: string;
    }
  | {
      readonly kind: "membership";
      readonly thread: ScopedThreadRef;
      readonly homeId?: EnvironmentId;
    };

export const useThreadFolderDialog = create<{ request: ThreadFolderDialogRequest | null }>(() => ({
  request: null,
}));

export function openThreadFolderDialog(request: ThreadFolderDialogRequest) {
  useThreadFolderDialog.setState({ request });
}
