import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import {
  McpAppHostRefusal,
  mcpAppStyleVariables,
  type McpAppDisplayMode,
  type McpAppHost,
  type McpAppHostContext,
} from "@t3tools/client-runtime/mcp-apps";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { MCP_APP_COLOR_SCHEME_PARAM } from "@t3tools/shared/mcpApp";
import { useRef, useState, type ReactNode } from "react";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";
import { attachMcpAppDocumentLink } from "./mcpAppDocumentLink";

export const sandboxedAppCommandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new McpAppHostRefusal({
    message:
      error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  });
};

export function buildMcpAppHostContext(input: {
  readonly theme: {
    readonly appearance: "light" | "dark";
    readonly variables: Readonly<Record<string, string>>;
  };
  readonly displayMode: McpAppDisplayMode;
  readonly availableDisplayModes: ReadonlyArray<McpAppDisplayMode>;
  readonly containerDimensions: McpAppHostContext["containerDimensions"];
  readonly toolDefinition?: unknown;
  readonly t3?: McpAppHostContext["t3"];
}): McpAppHostContext {
  return {
    theme: input.theme.appearance,
    styles: { variables: mcpAppStyleVariables(input.theme.variables) },
    displayMode: input.displayMode,
    availableDisplayModes: input.availableDisplayModes,
    containerDimensions: input.containerDimensions,
    platform: isElectron ? "desktop" : "web",
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: `t3-code/${APP_VERSION}`,
    deviceCapabilities: {
      touch: window.matchMedia("(pointer: coarse)").matches,
      hover: window.matchMedia("(hover: hover)").matches,
    },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...(input.toolDefinition === undefined ? {} : { toolInfo: { tool: input.toolDefinition } }),
    ...(input.t3 === undefined ? {} : { t3: input.t3 }),
  };
}

export async function openSandboxedAppLink(
  frame: HTMLIFrameElement | null,
  url: string,
): Promise<void> {
  if (document.activeElement !== frame || !navigator.userActivation?.isActive) {
    throw new McpAppHostRefusal({ message: "Links open only from a click in the app." });
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function SandboxedAppFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly title: string;
  readonly appearance: "light" | "dark";
  readonly allow?: string | undefined;
  readonly className?: string;
  readonly createHost: (input: {
    readonly frame: HTMLIFrameElement;
    readonly post: (message: unknown) => void;
  }) => McpAppHost;
  readonly onFrameChange?: ((frame: HTMLIFrameElement | null) => void) | undefined;
  readonly onHostChange?: ((host: McpAppHost | null) => void) | undefined;
  readonly onBridgeMissing?: (() => void) | undefined;
  readonly navigatedAwayFallback: ReactNode;
  readonly loadErrorFallback: ReactNode;
}) {
  const [navigatedAway, setNavigatedAway] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<McpAppHost | null>(null);
  // The frame keeps its first URL: a re-minted one would reload the app.
  const [src, setSrc] = useState<string | null>(null);
  const asset = useLongLivedAssetUrl(src === null ? props.environmentId : null, props.resource);
  if (src === null && asset._tag === "Success") {
    // The app paints before `ui/initialize`, so it reads the initial scheme from its URL.
    const url = new URL(asset.url);
    url.searchParams.set(MCP_APP_COLOR_SCHEME_PARAM, props.appearance);
    setSrc(url.toString());
  }

  // Navigation retains the frame window; reject second loads to prevent impersonation.
  const loadCount = useRef(0);
  const onFrameLoad = () => {
    loadCount.current += 1;
    if (loadCount.current > 1) {
      hostRef.current?.dispose();
      setNavigatedAway(true);
    }
  };

  // The host belongs to this frame element, which is replaced when the document is reopened.
  const attachFrame = (frame: HTMLIFrameElement) => {
    frameRef.current = frame;
    props.onFrameChange?.(frame);
    let host: McpAppHost | null = null;
    const documentLink = attachMcpAppDocumentLink(
      frame,
      (data) => host?.receive(data),
      () => props.onBridgeMissing?.(),
    );
    host = props.createHost({
      frame,
      post: documentLink.post,
    });
    hostRef.current = host;
    props.onHostChange?.(host);
    window.addEventListener("message", documentLink.receive);
    return () => {
      window.removeEventListener("message", documentLink.receive);
      void host.teardown();
      if (hostRef.current === host) {
        hostRef.current = null;
        props.onHostChange?.(null);
      }
      if (frameRef.current === frame) {
        frameRef.current = null;
        props.onFrameChange?.(null);
      }
    };
  };

  if (navigatedAway) return props.navigatedAwayFallback;
  if (src !== null) {
    return (
      <iframe
        ref={attachFrame}
        src={src}
        title={props.title}
        // Omitting allow-same-origin isolates the app from the session.
        sandbox="allow-scripts allow-forms"
        allow={props.allow}
        onLoad={onFrameLoad}
        className={props.className}
        style={{ colorScheme: props.appearance }}
      />
    );
  }
  return asset._tag === "Failure" ? props.loadErrorFallback : null;
}
