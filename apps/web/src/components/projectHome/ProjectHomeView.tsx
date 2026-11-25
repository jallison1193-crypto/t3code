import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  buildCoordinatorPatch,
  coordinatorThreadIdOf,
} from "@t3tools/client-runtime/coordinator-thread";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  resolveProjectCoordinatorState,
  selectProjectHomeMember,
} from "@t3tools/client-runtime/project-home";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { Atom } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { AlertCircleIcon, BotIcon, FolderIcon, LockIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { BotHomeView } from "~/bots/BotHomeView";
import { isBotEnvironmentEnabled, isBotProjectGroup } from "~/bots/bots.logic";
import { isElectron } from "~/env";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useThreadActions } from "~/hooks/useThreadActions";
import { newThreadId } from "~/lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "~/providerInstances";
import { readProject, useQuietThreadShell } from "~/state/entities";
import { readEnvironment, readEnvironmentProviders, useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useEnvironmentShellStatus } from "~/state/shell";
import { threadEnvironment, useEnvironmentThread } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { isThreadRouteSnapshotAuthoritative } from "~/threadRoutes";
import { DEFAULT_INTERACTION_MODE } from "~/types";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ProjectViewTabs } from "./CoordinatorHeaderTabs";

const FALSE_PERMISSION_ATOM = Atom.make(false);
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

// One creation per project across StrictMode double effects and quick revisits.
const inFlightCoordinatorCreations = new Map<string, Promise<ThreadId | null>>();

function resolveCoordinatorCreateDefaults(environmentId: EnvironmentId, projectId: ProjectId) {
  const projectRef = scopeProjectRef(environmentId, projectId);
  const project = readProject(projectRef);
  const settings =
    readEnvironment(environmentId)?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = readEnvironmentProviders(environmentId) ?? EMPTY_PROVIDERS;
  const resolvedProjectSettings = resolveProjectSettings(settings, projectId, project ?? undefined);
  const defaultSelection =
    resolvedProjectSettings.settings.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(providers, settings, projectId);
  const resolution = resolveNewThreadModelSelection({
    defaultSelection,
    fallbackSelection: settings.fallbackModelSelection,
    providers,
    settings,
    projectId,
    now: Date.now(),
  });
  const modelSelection: ModelSelection = resolution.selection ??
    defaultSelection ?? {
      instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
      model: DEFAULT_MODEL,
    };
  return {
    modelSelection,
    runtimeMode: resolvedProjectSettings.settings.defaultRuntimeMode,
    interactionMode: DEFAULT_INTERACTION_MODE,
  };
}

export function ProjectHomeView({ projectKey }: { readonly projectKey: string }) {
  const gt = useGT();
  const navigate = useNavigate();
  const projectGroups = useSettingsProjectGroups({ includeBots: true });
  const { isReady: environmentsReady, presentationById } = useEnvironments();
  const projectGroup = projectGroups.find((group) => group.projectKey === projectKey) ?? null;

  const isBotGroup =
    projectGroup !== null &&
    isBotProjectGroup(
      projectGroup,
      (environmentId) => presentationById.get(environmentId)?.serverConfig?.settings,
    );
  const botEnvironment = isBotGroup
    ? presentationById.get(projectGroup.memberProjects[0]!.environmentId)
    : undefined;
  const botEnabledHere = isBotEnvironmentEnabled(botEnvironment?.serverConfig?.settings);

  const memberSelection =
    projectGroup === null || isBotGroup
      ? { kind: "disconnected" as const }
      : selectProjectHomeMember(projectGroup.memberProjects, (environmentId) =>
          presentationById.get(environmentId),
        );

  const selectedMember = memberSelection.kind === "supported" ? memberSelection.member : null;
  const selectedEnvironmentId = selectedMember?.environmentId ?? null;
  const selectedProjectId = selectedMember?.id ?? null;
  const targetKey =
    selectedMember !== null
      ? scopedProjectKey(scopeProjectRef(selectedMember.environmentId, selectedMember.id))
      : null;

  const candidateCoordinatorId =
    memberSelection.kind === "supported"
      ? coordinatorThreadIdOf(
          memberSelection.environment.serverConfig?.settings,
          memberSelection.member.id,
        )
      : null;
  const candidateThreadRef =
    selectedEnvironmentId !== null && candidateCoordinatorId !== null
      ? scopeThreadRef(selectedEnvironmentId, candidateCoordinatorId)
      : null;

  const threadShell = useQuietThreadShell(candidateThreadRef);
  const shellStatus = useEnvironmentShellStatus(selectedEnvironmentId);
  const shellBootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const threadDetail = useEnvironmentThread(
    candidateThreadRef?.environmentId ?? null,
    candidateThreadRef?.threadId ?? null,
  );

  const canUpdateSettings = useAtomValue(
    selectedEnvironmentId !== null
      ? serverEnvironment.updateSettings.permissionAtom(selectedEnvironmentId)
      : FALSE_PERMISSION_ATOM,
  );
  const canCreateThread = useEnvironmentScope(selectedEnvironmentId, AuthOrchestrationOperateScope);

  const coordinatorState = resolveProjectCoordinatorState({
    selection: memberSelection,
    shellBootstrapComplete,
    threadShell,
    unlistedThreadDetail: candidateThreadRef !== null && threadShell === null ? threadDetail : null,
    canUpdateSettings,
    canCreateThread,
  });

  const createThread = useOrchestrationCommand(threadEnvironment.create, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const { pinThread } = useThreadActions();

  const [creationError, setCreationError] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);

  const activeCreationError =
    targetKey !== null && creationError?.key === targetKey ? creationError.message : null;

  const ensureCoordinatorThread = useStableCallback(
    async (
      key: string,
      environmentId: EnvironmentId,
      projectId: ProjectId,
    ): Promise<ThreadId | null> => {
      const existingFlight = inFlightCoordinatorCreations.get(key);
      if (existingFlight) {
        return existingFlight;
      }
      const promise = (async (): Promise<ThreadId | null> => {
        const createdThreadId = newThreadId();
        const defaults = resolveCoordinatorCreateDefaults(environmentId, projectId);
        const createResult = await createThread({
          environmentId,
          input: {
            threadId: createdThreadId,
            projectId,
            title: gt("Coordinator"),
            modelSelection: defaults.modelSelection,
            runtimeMode: defaults.runtimeMode,
            interactionMode: defaults.interactionMode,
            branch: null,
            worktreePath: null,
          },
        });
        if (createResult._tag === "Failure") {
          if (isAtomCommandInterrupted(createResult)) return null;
          throw squashAtomCommandFailure(createResult);
        }

        const currentSettings = readEnvironment(environmentId)?.serverConfig?.settings;
        if (!currentSettings) {
          throw new Error("Server settings are not loaded yet.");
        }
        const updateResult = await updateSettings({
          environmentId,
          input: {
            patch: buildCoordinatorPatch(currentSettings, projectId, createdThreadId),
          },
        });
        if (updateResult._tag === "Failure") {
          if (isAtomCommandInterrupted(updateResult)) return null;
          throw squashAtomCommandFailure(updateResult);
        }

        if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
          const pinResult = await pinThread(scopeThreadRef(environmentId, createdThreadId));
          if (pinResult._tag === "Failure" && !isAtomCommandInterrupted(pinResult)) {
            const failure = squashAtomCommandFailure(pinResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: gt("Failed to pin coordinator thread"),
                description: failure instanceof Error ? failure.message : String(failure),
              }),
            );
          }
        }
        return createdThreadId;
      })().finally(() => {
        inFlightCoordinatorCreations.delete(key);
      });

      inFlightCoordinatorCreations.set(key, promise);
      return promise;
    },
  );

  const existingThreadId = coordinatorState.kind === "exists" ? coordinatorState.threadId : null;
  const shouldCreate =
    coordinatorState.kind === "needs-create" &&
    targetKey !== null &&
    selectedEnvironmentId !== null &&
    selectedProjectId !== null &&
    activeCreationError === null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the project home is a redirect to its coordinator thread, created on first visit
  useEffect(() => {
    if (selectedEnvironmentId === null) return;
    const openThread = (threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: selectedEnvironmentId, threadId },
        replace: true,
      });
    if (existingThreadId !== null) {
      openThread(existingThreadId);
      return;
    }
    if (!shouldCreate || targetKey === null || selectedProjectId === null) return;
    let cancelled = false;
    ensureCoordinatorThread(targetKey, selectedEnvironmentId, selectedProjectId).then(
      (threadId) => {
        if (!cancelled && threadId !== null) openThread(threadId);
      },
      (error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : gt("Failed to create coordinator thread.");
        setCreationError({ key: targetKey, message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    ensureCoordinatorThread,
    existingThreadId,
    gt,
    navigate,
    selectedEnvironmentId,
    selectedProjectId,
    shouldCreate,
    targetKey,
  ]);

  const openProjectSettings = () => {
    void navigate({
      to: "/settings/projects",
      search: {
        project: projectGroup !== null ? projectKey : undefined,
        machine: undefined,
      },
    });
  };

  const handleRetryCreation = () => {
    setCreationError(null);
  };

  if (projectGroup !== null && isBotGroup) {
    if (botEnabledHere) {
      return <BotHomeView projectKey={projectKey} projectGroup={projectGroup} />;
    }
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <WorkspacePageHeader electron={isElectron} className="bg-background">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <BotIcon className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-sm font-medium text-foreground">
                <T>Bots</T>
              </h1>
            </div>
          </WorkspacePageHeader>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>Bots are turned off</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Turn Bots on in Settings to view and run this bot.</T>
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigate({ to: "/settings/general" })}
              >
                <T>Open Settings</T>
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      </SidebarInset>
    );
  }

  let body: React.ReactNode;
  if (projectGroup === null) {
    if (!environmentsReady) {
      body = (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <T>Loading project…</T>
        </div>
      );
    } else {
      body = (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>
              <T>Project not found</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>This project could not be found in your connected environments.</T>
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={openProjectSettings}>
              <T>Open project settings</T>
            </Button>
          </EmptyContent>
        </Empty>
      );
    }
  } else if (activeCreationError !== null) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircleIcon />
          </EmptyMedia>
          <EmptyTitle>
            <T>Couldn&apos;t start coordinator</T>
          </EmptyTitle>
          <EmptyDescription>{activeCreationError}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRetryCreation}>
              <T>Retry</T>
            </Button>
            <Button variant="ghost" size="sm" onClick={openProjectSettings}>
              <T>Project settings</T>
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    );
  } else {
    switch (coordinatorState.kind) {
      case "disconnected":
        body = (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WifiOffIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>Environment offline</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Connect one of this project&apos;s environments to open its coordinator.</T>
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={openProjectSettings}>
                <T>Open project settings</T>
              </Button>
            </EmptyContent>
          </Empty>
        );
        break;
      case "unsupported":
        body = (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>Coordinator unavailable</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>This environment does not support project coordinator settings yet.</T>
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={openProjectSettings}>
                <T>Open project settings</T>
              </Button>
            </EmptyContent>
          </Empty>
        );
        break;
      case "no-permission":
        body = (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LockIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>Permission required</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>
                  You don&apos;t have permission to create or configure this project&apos;s
                  coordinator thread.
                </T>
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={openProjectSettings}>
                <T>Open project settings</T>
              </Button>
            </EmptyContent>
          </Empty>
        );
        break;
      case "error":
        body = (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>Couldn&apos;t load coordinator</T>
              </EmptyTitle>
              <EmptyDescription>{coordinatorState.message}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={openProjectSettings}>
                <T>Open project settings</T>
              </Button>
            </EmptyContent>
          </Empty>
        );
        break;
      case "loading":
      case "needs-create":
      case "exists":
        body = (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {coordinatorState.kind === "needs-create"
              ? gt("Starting coordinator…")
              : gt("Opening coordinator…")}
          </div>
        );
        break;
    }
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BotIcon className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-sm font-medium text-foreground">
              <T>Coordinator</T>
            </h1>
          </div>
          {projectGroup !== null ? (
            <ProjectViewTabs projectKey={projectKey} active="conversation" />
          ) : null}
        </WorkspacePageHeader>
        {body}
      </div>
    </SidebarInset>
  );
}
