import type { EnvironmentId, ProjectId, ServerConfig, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { EnvironmentConnectionPhase } from "./connection/presentation.ts";
import { coordinatorThreadIdOf } from "./coordinatorThread.ts";
import type { EnvironmentThreadState } from "./state/threadState.ts";

export interface ProjectHomeMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

export interface ProjectHomeEnvironment {
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: Pick<ServerConfig, "environment" | "settings"> | null;
}

export type ProjectHomeMemberSelection<
  Member extends ProjectHomeMember = ProjectHomeMember,
  Env extends ProjectHomeEnvironment = ProjectHomeEnvironment,
> =
  | {
      readonly kind: "supported";
      readonly member: Member;
      readonly environment: Env;
    }
  | { readonly kind: "unsupported" }
  | { readonly kind: "disconnected" };

export function selectProjectHomeMember<
  Member extends ProjectHomeMember,
  Env extends ProjectHomeEnvironment,
>(
  members: ReadonlyArray<Member>,
  getEnvironment: (environmentId: EnvironmentId) => Env | null | undefined,
): ProjectHomeMemberSelection<Member, Env> {
  let hasConnectedUnsupported = false;
  for (const member of members) {
    const environment = getEnvironment(member.environmentId);
    if (
      !environment ||
      environment.connection.phase !== "connected" ||
      environment.serverConfig === null
    ) {
      continue;
    }
    if (environment.serverConfig.environment.capabilities.projectSettingsOverrides === true) {
      return { kind: "supported", member, environment };
    }
    hasConnectedUnsupported = true;
  }
  return { kind: hasConnectedUnsupported ? "unsupported" : "disconnected" };
}

export type ProjectCoordinatorState =
  | { readonly kind: "disconnected" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "loading" }
  | { readonly kind: "no-permission" }
  | { readonly kind: "exists"; readonly threadId: ThreadId }
  | { readonly kind: "needs-create"; readonly staleThreadId: ThreadId | null }
  | { readonly kind: "error"; readonly message: string };

export interface ProjectCoordinatorThreadShell {
  readonly deletedAt?: string | null | undefined;
}

export function resolveProjectCoordinatorState(input: {
  readonly selection: ProjectHomeMemberSelection;
  readonly shellBootstrapComplete: boolean;
  readonly threadShell: ProjectCoordinatorThreadShell | null;
  readonly unlistedThreadDetail: EnvironmentThreadState | null;
  readonly canUpdateSettings: boolean;
  readonly canCreateThread?: boolean;
}): ProjectCoordinatorState {
  if (input.selection.kind === "disconnected") return { kind: "disconnected" };
  if (input.selection.kind === "unsupported") return { kind: "unsupported" };

  const { member, environment } = input.selection;
  const coordinatorThreadId = coordinatorThreadIdOf(environment.serverConfig?.settings, member.id);

  if (coordinatorThreadId !== null) {
    if (input.threadShell !== null) {
      if (input.threadShell.deletedAt == null) {
        return { kind: "exists", threadId: coordinatorThreadId };
      }
      // Shell marks the coordinator thread deleted; treat it as stale below.
    } else {
      if (!input.shellBootstrapComplete) {
        return { kind: "loading" };
      }
      const detail = input.unlistedThreadDetail;
      if (detail === null) {
        return { kind: "loading" };
      }
      const projection = Option.getOrNull(detail.data);
      if (projection !== null) {
        if (projection.thread.deletedAt === null) {
          return { kind: "exists", threadId: coordinatorThreadId };
        }
        // Projection marks the coordinator thread deleted; treat it as stale below.
      } else if (detail.status === "deleted") {
        // Server confirmed the coordinator thread no longer exists; treat it as stale below.
      } else if (Option.isSome(detail.error)) {
        return { kind: "error", message: detail.error.value };
      } else {
        return { kind: "loading" };
      }
    }
  }

  if (!input.canUpdateSettings || input.canCreateThread === false) {
    return { kind: "no-permission" };
  }
  return { kind: "needs-create", staleThreadId: coordinatorThreadId };
}
