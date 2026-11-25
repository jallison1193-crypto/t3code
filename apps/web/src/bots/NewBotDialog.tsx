import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
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
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { BotModelPicker } from "./BotModelPicker";
import { resolveFirstSupportedBotModelSelection } from "./bots.logic";
import { closeNewBotDialog, type NewBotDialogRequest, useNewBotDialog } from "./newBotDialogState";
import { useBotWritableEnvironments } from "./useBots";

const EMPTY_PROVIDERS_ATOM = Atom.make(EMPTY_SERVER_PROVIDERS);

export function NewBotDialogHost() {
  const request = useNewBotDialog((state) => state.request);
  return request ? <NewBotDialog request={request} /> : null;
}

function NewBotDialog({ request }: { readonly request: NewBotDialogRequest }) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const writableEnvironments = useBotWritableEnvironments();
  const defaultEnvironmentId =
    (request.environmentId &&
    writableEnvironments.some((env) => env.environmentId === request.environmentId)
      ? request.environmentId
      : undefined) ??
    writableEnvironments.find((env) => env.environmentId === primaryEnvironmentId)?.environmentId ??
    writableEnvironments[0]?.environmentId ??
    null;

  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(defaultEnvironmentId);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [modelPick, setModelPick] = useState<{
    readonly environmentId: EnvironmentId | null;
    readonly value: ModelSelection | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createBot = useAtomCommand(serverEnvironment.createBot, {
    label: "bot create",
    reportFailure: false,
  });

  const resolvedEnvironmentId =
    environmentId !== null &&
    writableEnvironments.some((env) => env.environmentId === environmentId)
      ? environmentId
      : (writableEnvironments[0]?.environmentId ?? null);
  const selectedEnvironment =
    writableEnvironments.find((env) => env.environmentId === resolvedEnvironmentId) ?? null;
  const selectedSettings = selectedEnvironment?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const selectedProviders =
    useAtomValue(
      resolvedEnvironmentId !== null
        ? serverEnvironment.providersValueAtom(resolvedEnvironmentId)
        : EMPTY_PROVIDERS_ATOM,
    ) ?? EMPTY_SERVER_PROVIDERS;
  const seededModelSelection = resolveFirstSupportedBotModelSelection(
    selectedSettings,
    providerInstanceEntriesFor(selectedProviders, selectedSettings, null),
  );
  const modelSelection =
    modelPick !== null && modelPick.environmentId === resolvedEnvironmentId
      ? modelPick.value
      : seededModelSelection;

  const submit = async () => {
    if (saving || resolvedEnvironmentId === null) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(gt("Enter a name for this bot."));
      return;
    }
    if (/[\r\n\v\f\u0085\u2028\u2029]/u.test(trimmedName)) {
      setError(gt("Bot name must be a single line."));
      return;
    }
    setError(null);
    setSaving(true);
    const result = await createBot({
      environmentId: resolvedEnvironmentId,
      input: {
        name: trimmedName,
        goal: goal.trim(),
        ...(modelSelection === null ? {} : { modelSelection }),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      const description =
        failure instanceof Error
          ? (thrownErrorMessage(failure, messages) ?? failure.message)
          : String(failure);
      setError(description);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not create bot"),
          description,
        }),
      );
      return;
    }
    closeNewBotDialog();
    const projectKey = derivePhysicalProjectKeyFromPath(
      resolvedEnvironmentId,
      result.value.workspaceRoot,
    );
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey },
    });
  };

  return (
    <Dialog
      open
      disablePointerDismissal={saving}
      onOpenChange={(open) => {
        if (!open && !saving) closeNewBotDialog();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>New bot</T>
          </DialogTitle>
          <DialogDescription>
            <T>Create a named bot with its own goal, model, triggers, and run history.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="new-bot-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {writableEnvironments.length > 1 && resolvedEnvironmentId !== null ? (
              <div className="space-y-1.5">
                <Label htmlFor="new-bot-environment">
                  <T>Runs on</T>
                </Label>
                <Select
                  value={resolvedEnvironmentId}
                  disabled={saving}
                  onValueChange={(nextId) => {
                    const match = writableEnvironments.find((env) => env.environmentId === nextId);
                    if (!match) return;
                    setEnvironmentId(match.environmentId);
                    setModelPick(null);
                  }}
                >
                  <SelectTrigger id="new-bot-environment" size="sm">
                    <SelectValue>
                      <span className="flex items-center gap-2">
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(
                            selectedEnvironment?.serverConfig ?? null,
                          )}
                          className="size-4"
                        />
                        {selectedEnvironment?.label ?? gt("Select environment")}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {writableEnvironments.map((env) => (
                      <SelectItem
                        key={env.environmentId}
                        value={env.environmentId}
                        label={env.label}
                      >
                        <span className="flex items-center gap-2">
                          <EnvironmentMachineIcon
                            kind={resolveEnvironmentMachineKind(env.serverConfig)}
                            className="size-4"
                          />
                          <span className="truncate">{env.label}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="new-bot-name">
                <T>Name</T>
              </Label>
              <Input
                id="new-bot-name"
                autoFocus
                disabled={saving}
                maxLength={120}
                placeholder={gt("e.g. Morning PR Digest")}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-bot-goal">
                <T>Goal</T>
              </Label>
              <Textarea
                id="new-bot-goal"
                disabled={saving}
                rows={4}
                placeholder={gt("Describe what this bot is responsible for on every run.")}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
            </div>

            {resolvedEnvironmentId !== null ? (
              <div className="space-y-1.5">
                <Label>
                  <T>Model</T>
                </Label>
                <BotModelPicker
                  environmentId={resolvedEnvironmentId}
                  projectId={null}
                  value={modelSelection}
                  disabled={saving}
                  onChange={(next) =>
                    setModelPick({ environmentId: resolvedEnvironmentId, value: next })
                  }
                />
              </div>
            ) : (
              <p className="text-sm text-destructive" role="status">
                <T>No connected environment has Bots enabled and settings write permission.</T>
              </p>
            )}

            {error ? (
              <p className="text-sm text-destructive" role="status">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={saving} />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            type="submit"
            form="new-bot-form"
            size="sm"
            disabled={saving || resolvedEnvironmentId === null || name.trim().length === 0}
          >
            {saving ? <T>Creating…</T> : <T>Create bot</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
