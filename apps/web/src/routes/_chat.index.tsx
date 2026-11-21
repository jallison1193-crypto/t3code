import { workspaceAreaProps } from "../lib/workspaceFocus";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { resolveChatIndexLandingTarget } from "../chatIndexLanding.logic";
import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { Button } from "../components/ui/button";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  getClientSettings,
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import {
  readProject,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useVisibleThreadShells,
} from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

export function ChatIndexLandingView({
  authGateState,
}: {
  readonly authGateState: { readonly status: string };
}) {
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding />;
}

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  return <ChatIndexLandingView authGateState={authGateState} />;
}

function IndexDraftLanding() {
  const clientSettingsHydrated = useClientSettingsHydrated();
  const appMode = useClientSettings((settings) => settings.appMode);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();
  // Read at effect time; this page can stay mounted while the router is already navigating away.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startedAttemptRef = useRef<number | null>(null);
  const appliedWorkSidebarRef = useRef(false);
  const navigatedWorkProjectKeyRef = useRef<string | null>(null);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const landingTarget = clientSettingsHydrated
    ? resolveChatIndexLandingTarget({
        appMode,
        projects,
        threads,
        projectGroupingSettings,
        primaryEnvironmentId,
        getScratchWorkspaceRoot: (environmentId) =>
          serverConfigs.get(environmentId)?.scratchWorkspaceRoot,
      })
    : null;
  const attempt = startState.retryRequest;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens Work project home (with Projects sidebar) or starts a Code draft thread while still on the index
  useEffect(() => {
    if (!clientSettingsHydrated || landingTarget === null || !isStillOnIndex()) {
      return;
    }

    if (appMode === "work") {
      if (!appliedWorkSidebarRef.current) {
        appliedWorkSidebarRef.current = true;
        if (getClientSettings().sidebarLayout !== "projects") {
          void persistClientSettingsPatch({ sidebarLayout: "projects" });
        }
      }
      if (
        !bootstrapped ||
        landingTarget.kind !== "project-home" ||
        navigatedWorkProjectKeyRef.current === landingTarget.projectKey
      ) {
        return;
      }
      if (readProject(landingTarget.projectRef) === null) {
        return;
      }
      navigatedWorkProjectKeyRef.current = landingTarget.projectKey;
      void router
        .navigate({
          to: "/projects/$projectKey",
          params: { projectKey: landingTarget.projectKey },
          replace: true,
        })
        .catch(() => {
          if (navigatedWorkProjectKeyRef.current === landingTarget.projectKey) {
            navigatedWorkProjectKeyRef.current = null;
          }
        });
      return;
    }

    appliedWorkSidebarRef.current = false;
    navigatedWorkProjectKeyRef.current = null;

    // Starting a draft after the user has left would replace the page they picked.
    if (landingTarget.kind !== "draft-thread" || startedAttemptRef.current === attempt) {
      return;
    }
    if (readProject(landingTarget.projectRef) === null) {
      return;
    }
    startedAttemptRef.current = attempt;
    void handleNewThread(landingTarget.projectRef, { replace: true })
      .then((opened) => {
        if (opened === null) {
          setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
        }
      })
      .catch(() => {
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [
    appMode,
    attempt,
    bootstrapped,
    clientSettingsHydrated,
    handleNewThread,
    landingTarget,
    router,
  ]);

  if (!clientSettingsHydrated || landingTarget === null) {
    return null;
  }
  if (landingTarget.kind === "project-home") {
    return null;
  }
  if (landingTarget.kind === "draft-thread") {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // A pending environment cannot prove the workspace is empty.
  return bootstrapped ? <NoProjectsHero /> : null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  const gt = useGT();
  const contentArea = workspaceAreaProps("home", 1, gt("Home", { $context: "the home screen" }));
  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>
            <T>Couldn’t start a new thread</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>The project is still available. Try opening the draft again.</T>
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              <T>Try again</T>
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
