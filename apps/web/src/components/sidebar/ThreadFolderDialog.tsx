import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { ThreadSectionId } from "@t3tools/contracts/settings";
import { T, useGT, useMessages } from "gt-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useHiddenThreadKeys, useQuietThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  canChangeThreadFolder,
  currentThreadFolder,
  threadFolderHomeProblem,
  threadFolderMembershipRequest,
  threadFolderPatchApplied,
  threadFolders,
} from "./threadFolders.logic";
import { useThreadFolderDialog, type ThreadFolderDialogRequest } from "./threadFolderDialogState";
import {
  readThreadFolderSource,
  readableThreadFolderSourcesAtom,
  threadFolderHomesAtom,
} from "./threadFoldersState";

const NO_FOLDER = "none";

export function ThreadFolderDialogHost() {
  const request = useThreadFolderDialog((state) => state.request);
  return request ? <ThreadFolderDialog request={request} /> : null;
}

function ThreadFolderDialog({ request }: { request: ThreadFolderDialogRequest }) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const homes = useAtomValue(threadFolderHomesAtom);
  const readableSources = useAtomValue(readableThreadFolderSourcesAtom);
  const hiddenKeys = useHiddenThreadKeys();
  const member = request.kind === "membership" ? request.thread : null;
  const shell = useQuietThreadShell(member);
  const sourceAvailable =
    member !== null &&
    shell?.deletedAt === null &&
    readableSources.has(member.environmentId) &&
    !hiddenKeys.has(scopedThreadKey(member));

  const [selectedHomeId, setSelectedHomeId] = useState(
    request.kind === "create" ? undefined : request.homeId,
  );
  const [selectedFolderId, setSelectedFolderId] = useState<ThreadSectionId | null>();
  const [draftName, setDraftName] = useState<string>();
  const [newFolderId] = useState(() => ThreadSectionId.make(randomUUID()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const setMembership = useAtomCommand(serverEnvironment.setThreadSectionMembership, {
    reportFailure: false,
  });
  const homeId = selectedHomeId ?? (homes.length === 1 ? homes[0]?.id : undefined);
  const home = homes.find((candidate) => candidate.id === homeId);
  const folders = home ? threadFolders(home.sections) : [];
  const folderOptions = [
    { value: NO_FOLDER, label: gt("No folder") },
    ...folders.map(({ id, name }) => ({
      value: id,
      label: folders.some((other) => other.id !== id && other.name === name)
        ? `${name} (${id})`
        : name,
    })),
  ];
  const currentFolderId =
    home && member !== null ? currentThreadFolder(home.sections, member) : null;
  const destinationId = selectedFolderId === undefined ? currentFolderId : selectedFolderId;
  const folder = "sectionId" in request ? home?.sections[request.sectionId] : null;
  const name = draftName ?? folder?.name ?? ("name" in request ? request.name : "");
  const fixedHome = request.kind === "rename" || request.kind === "delete";
  const homeProblem = threadFolderHomeProblem(home, member !== null);
  const connectionError = gt("Connect to the folder’s home server to make changes.");
  const permissionError = gt("This connection cannot change thread folders.");
  const problem =
    !homeId && homes.length > 0
      ? null
      : homeProblem === "offline"
        ? connectionError
        : homeProblem === "read-only"
          ? permissionError
          : fixedHome && !folder
            ? gt("This folder no longer exists.")
            : null;
  const canSave =
    !busy &&
    home !== undefined &&
    !problem &&
    (request.kind === "membership"
      ? canChangeThreadFolder(currentFolderId, destinationId, home.sections, sourceAvailable)
      : request.kind === "delete" || (name.trim() !== "" && name.trim() !== folder?.name));

  const close = () => {
    if (useThreadFolderDialog.getState().request === request) {
      useThreadFolderDialog.setState({ request: null });
    }
  };

  const save = async () => {
    if (!canSave || !home) return;
    const latest = appAtomRegistry.get(threadFolderHomesAtom).find(({ id }) => id === home.id);
    const latestProblem = threadFolderHomeProblem(latest, member !== null);
    if (!latest || latestProblem) {
      setError(latestProblem === "read-only" ? permissionError : connectionError);
      return;
    }
    if (member !== null && destinationId !== null && !readThreadFolderSource(member)) {
      setError(gt("Thread unavailable"));
      return;
    }
    if ("sectionId" in request && !latest.sections[request.sectionId]) {
      setError(gt("This folder no longer exists."));
      return;
    }
    setBusy(true);
    setError(null);
    const describeFailure = (cause: unknown) =>
      thrownErrorMessage(cause, m) ?? gt("An error occurred.");
    const submission = await settlePromise(async () => {
      if (request.kind === "membership") {
        const result = await setMembership(
          threadFolderMembershipRequest(home.id, request.thread, destinationId),
        );
        return result._tag === "Failure" ? describeFailure(squashAtomCommandFailure(result)) : null;
      }
      const sectionId = request.kind === "create" ? newFolderId : request.sectionId;
      const nextName = request.kind === "delete" ? null : name.trim();
      const result = await updateSettings({
        environmentId: home.id,
        input: {
          patch:
            request.kind === "rename"
              ? { renameThreadSection: { id: sectionId, name: name.trim() } }
              : { threadSections: { [sectionId]: nextName === null ? null : { name: nextName } } },
        },
      });
      if (result._tag === "Failure") return describeFailure(squashAtomCommandFailure(result));
      if (!threadFolderPatchApplied(result.value, sectionId, nextName)) {
        return gt("The home server did not apply the folder change.");
      }
      return null;
    });
    setBusy(false);
    const failure =
      submission._tag === "Failure"
        ? describeFailure(squashAtomCommandFailure(submission))
        : submission.value;
    if (failure === null) close();
    else setError(failure);
  };

  const title = {
    create: gt("New thread folder"),
    rename: gt("Rename folder"),
    delete: gt("Delete folder"),
    membership: gt("Change thread folder"),
  }[request.kind];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {request.kind === "delete" ? (
              <DialogDescription>
                {gt('Delete "{name}"? Its threads will be kept.', {
                  name: folder?.name ?? request.name,
                })}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogPanel>
            {fixedHome && home && homes.length > 1 ? (
              <p className="text-sm text-muted-foreground">
                {gt("Home server: {name}", { name: home.label })}
              </p>
            ) : null}
            {!fixedHome && (homes.length > 1 || (homeId && !home)) ? (
              <div className="grid gap-2">
                <Label htmlFor={`${id}-home`}>
                  <T>Home server</T>
                </Label>
                <Select
                  items={homes.map(({ id, label }) => ({ value: id, label }))}
                  value={home?.id ?? null}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value !== null) setSelectedHomeId(EnvironmentId.make(value));
                    setSelectedFolderId(undefined);
                    setError(null);
                  }}
                >
                  <SelectTrigger id={`${id}-home`}>
                    <SelectValue placeholder={gt("Choose a server")} />
                  </SelectTrigger>
                  <SelectPopup>
                    {homes.map(({ id, label }) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {request.kind === "create" || request.kind === "rename" ? (
              <div className="grid gap-2">
                <Label htmlFor={`${id}-name`}>
                  <T>Folder name</T>
                </Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  disabled={busy}
                  required
                  onChange={(event) => {
                    setDraftName(event.target.value);
                    setError(null);
                  }}
                />
              </div>
            ) : null}
            {request.kind === "membership" && home ? (
              folders.length > 0 ? (
                <div className="grid gap-2">
                  <Label htmlFor={`${id}-folder`}>
                    <T>Thread folder</T>
                  </Label>
                  <Select
                    items={folderOptions}
                    value={destinationId ?? NO_FOLDER}
                    disabled={busy || !!problem}
                    onValueChange={(value) => {
                      if (value !== null)
                        setSelectedFolderId(
                          value === NO_FOLDER ? null : ThreadSectionId.make(value),
                        );
                      setError(null);
                    }}
                  >
                    <SelectTrigger id={`${id}-folder`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {folderOptions.map(({ value, label }) => (
                        <SelectItem
                          key={value}
                          value={value}
                          disabled={
                            !sourceAvailable && value !== currentFolderId && value !== NO_FOLDER
                          }
                        >
                          {label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <T>Create a thread folder in the Projects sidebar first.</T>
                </p>
              )
            ) : null}
            {request.kind === "membership" && !sourceAvailable ? (
              <p className="text-sm text-muted-foreground">
                <T>Thread unavailable</T>
              </p>
            ) : null}
            {error || problem ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error ?? problem}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              <T>Cancel</T>
            </DialogClose>
            <Button
              type="submit"
              variant={request.kind === "delete" ? "destructive" : "default"}
              disabled={!canSave}
            >
              {request.kind === "delete" ? gt("Delete folder") : gt("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
