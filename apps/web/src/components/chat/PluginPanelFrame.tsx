import type {
  EnvironmentId,
  PluginId,
  PluginStateScope,
  ProjectId,
  ServerPluginStateSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { makeMcpAppHost, type McpAppHost } from "@t3tools/client-runtime/mcp-apps";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { APP_VERSION } from "~/branding";
import { Button } from "~/components/ui/button";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  createPluginPanelRefusedHandlers,
  handlePluginPanelToolCall,
  resolvePluginPanelStatus,
} from "./pluginPanel.logic";
import {
  buildMcpAppHostContext,
  openSandboxedAppLink,
  SandboxedAppFrame,
  sandboxedAppCommandFailure,
} from "./SandboxedAppFrame";

const EMPTY_PLUGIN_STATE_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<ServerPluginStateSnapshot, never>
> = Atom.make<AsyncResult.AsyncResult<ServerPluginStateSnapshot, never>>(
  AsyncResult.initial(false),
).pipe(Atom.withLabel("plugin-panel:empty-state"));

function deliverStateSnapshot(
  host: McpAppHost | null,
  scope: "global" | "project",
  result: AsyncResult.AsyncResult<ServerPluginStateSnapshot, unknown>,
  lastDeliveredRef: { current: unknown },
) {
  if (host === null || result._tag !== "Success" || lastDeliveredRef.current === result) return;
  if (
    host.notify("t3/notifications/state-changed", {
      scope,
      value: result.value.value,
    })
  ) {
    lastDeliveredRef.current = result;
  }
}

export function PluginPanelFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly pluginId: PluginId;
  readonly panelId: PluginId;
}) {
  const configs = useServerConfigs();
  const pluginsSupported =
    configs.get(props.environmentId)?.environment.capabilities.environmentPlugins === true;
  const pluginsQuery = useEnvironmentQuery(
    pluginsSupported
      ? serverEnvironment.pluginsList({ environmentId: props.environmentId, input: {} })
      : null,
  );

  if (!pluginsSupported) {
    return <DisabledPluginPanelState />;
  }

  if (pluginsQuery.data === null && pluginsQuery.error !== null) {
    return <DisabledPluginPanelState />;
  }

  const state = resolvePluginPanelStatus(pluginsQuery.data?.plugins, props.pluginId, props.panelId);
  if (state.status === "loading") return null;
  if (state.status === "disabled") return <DisabledPluginPanelState />;

  return (
    <EnabledPluginPanelFrame
      environmentId={props.environmentId}
      threadId={props.threadId}
      projectId={props.projectId}
      pluginId={props.pluginId}
      panelId={props.panelId}
      title={state.title}
    />
  );
}

function DisabledPluginPanelState() {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-muted-foreground text-sm">
        <T>This plugin is off</T>
      </p>
      <Button size="xs" variant="outline" render={<Link to="/settings/plugins" />}>
        <T>Settings → Plugins</T>
      </Button>
    </div>
  );
}

function EnabledPluginPanelFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly pluginId: PluginId;
  readonly panelId: PluginId;
  readonly title: string;
}) {
  const gt = useGT();
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<McpAppHost | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const attachBox = (box: HTMLDivElement) => {
    setSize({ width: box.clientWidth, height: box.clientHeight });
    return observeResize(box, ([entry]) => {
      if (!entry) return;
      setSize({
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      });
    });
  };

  const getPluginState = useAtomCommand(serverEnvironment.getPluginState, {
    reportFailure: false,
  });
  const setPluginState = useAtomCommand(serverEnvironment.setPluginState, {
    reportFailure: false,
  });

  const globalStateResult = useAtomValue(
    serverEnvironment.pluginState({
      environmentId: props.environmentId,
      input: { pluginId: props.pluginId, scope: "global" },
    }),
  );
  const projectStateResult = useAtomValue(
    props.projectId === undefined
      ? EMPTY_PLUGIN_STATE_ATOM
      : serverEnvironment.pluginState({
          environmentId: props.environmentId,
          input: { pluginId: props.pluginId, scope: { projectId: props.projectId } },
        }),
  );

  const lastDeliveredGlobalRef = useRef<unknown>(null);
  const lastDeliveredProjectRef = useRef<unknown>(null);

  // Read live values without rebuilding the host and losing the panel session.
  const readLive = useStableCallback(() => ({
    theme,
    size,
    props,
    getPluginState,
    setPluginState,
    globalStateResult,
    projectStateResult,
  }));

  const createHost = ({ post }: { readonly post: (message: unknown) => void }) => {
    lastDeliveredGlobalRef.current = null;
    lastDeliveredProjectRef.current = null;
    const refused = createPluginPanelRefusedHandlers("inline");
    const host = makeMcpAppHost({
      app: {
        attachmentId: `plugin:${props.pluginId}:${props.panelId}`,
        server: props.pluginId,
        tool: props.panelId,
        resourceUri: `ui://plugin/${props.pluginId}/${props.panelId}`,
      },
      hostVersion: APP_VERSION,
      post,
      hostContext: () => {
        const current = readLive();
        return buildMcpAppHostContext({
          theme: current.theme,
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: {
            width: current.size.width,
            height: current.size.height,
          },
          t3: {
            environmentId: current.props.environmentId,
            pluginId: current.props.pluginId,
            panelId: current.props.panelId,
            ...(current.props.projectId === undefined
              ? {}
              : { projectId: current.props.projectId }),
            threadId: current.props.threadId,
          },
        });
      },
      callTool: (input) => {
        const current = readLive();
        return handlePluginPanelToolCall(input, {
          projectId: current.props.projectId,
          getState: async (scope: PluginStateScope) => {
            const result = await current.getPluginState({
              environmentId: current.props.environmentId,
              input: { pluginId: current.props.pluginId, scope },
            });
            if (result._tag !== "Success") throw sandboxedAppCommandFailure(result);
            return result.value.value;
          },
          setState: async (scope: PluginStateScope, value: unknown) => {
            const result = await current.setPluginState({
              environmentId: current.props.environmentId,
              input: { pluginId: current.props.pluginId, scope, value },
            });
            if (result._tag !== "Success") throw sandboxedAppCommandFailure(result);
          },
        });
      },
      openLink: (url) => openSandboxedAppLink(frameRef.current, url),
      ...refused,
      onRequestTeardown: () => undefined,
      onSizeChanged: () => undefined,
      onInitialized: () => {
        const current = readLive();
        deliverStateSnapshot(host, "global", current.globalStateResult, lastDeliveredGlobalRef);
        if (current.props.projectId !== undefined) {
          deliverStateSnapshot(
            host,
            "project",
            current.projectStateResult,
            lastDeliveredProjectRef,
          );
        }
      },
    });
    return host;
  };
  const handleFrameChange = (frame: HTMLIFrameElement | null) => {
    frameRef.current = frame;
  };
  const handleHostChange = (host: McpAppHost | null) => {
    hostRef.current = host;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes theme, fixed panel dimensions, and thread/project metadata to the plugin panel iframe
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, size.width, size.height, props.environmentId, props.projectId, props.threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards live global plugin state updates to the initialized iframe
  useEffect(() => {
    deliverStateSnapshot(hostRef.current, "global", globalStateResult, lastDeliveredGlobalRef);
  }, [globalStateResult]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards live project plugin state updates to the initialized iframe
  useEffect(() => {
    if (props.projectId === undefined) return;
    deliverStateSnapshot(hostRef.current, "project", projectStateResult, lastDeliveredProjectRef);
  }, [projectStateResult, props.projectId]);

  const resource = {
    _tag: "plugin-panel" as const,
    pluginId: props.pluginId,
    panelId: props.panelId,
  };

  return (
    <div ref={attachBox} className="relative size-full overflow-hidden">
      <SandboxedAppFrame
        environmentId={props.environmentId}
        resource={resource}
        title={gt("{title} plugin panel", { title: props.title })}
        appearance={theme.appearance}
        className="block size-full border-0"
        createHost={createHost}
        onFrameChange={handleFrameChange}
        onHostChange={handleHostChange}
        navigatedAwayFallback={
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            <T>
              The <Var>{props.title}</Var> panel left its page and was stopped
            </T>
          </p>
        }
        loadErrorFallback={
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            <T>
              Unable to load the <Var>{props.title}</Var> panel
            </T>
          </p>
        }
      />
    </div>
  );
}
