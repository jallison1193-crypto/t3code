import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { buildCoordinatorPatch } from "./coordinatorThread.ts";
import {
  resolveProjectCoordinatorState,
  selectProjectHomeMember,
  type ProjectHomeEnvironment,
  type ProjectHomeMember,
} from "./projectHome.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "./state/threadState.ts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

const envDisconnectedId = EnvironmentId.make("env-disconnected");
const envUnsupportedId = EnvironmentId.make("env-unsupported");
const envSupportedId = EnvironmentId.make("env-supported");
const envSupportedBackupId = EnvironmentId.make("env-supported-backup");

const projectDisconnected: ProjectHomeMember = {
  environmentId: envDisconnectedId,
  id: ProjectId.make("proj-disconnected"),
};
const projectUnsupported: ProjectHomeMember = {
  environmentId: envUnsupportedId,
  id: ProjectId.make("proj-unsupported"),
};
const projectSupported: ProjectHomeMember = {
  environmentId: envSupportedId,
  id: ProjectId.make("proj-supported"),
};
const projectSupportedBackup: ProjectHomeMember = {
  environmentId: envSupportedBackupId,
  id: ProjectId.make("proj-supported-backup"),
};

const coordinatorThreadId = ThreadId.make("thread-coordinator");

function makeEnvironment(options: {
  phase: ProjectHomeEnvironment["connection"]["phase"];
  hasConfig?: boolean;
  supportsOverrides?: boolean;
  coordinatorThreadId?: ThreadId | null;
  projectId?: ProjectId;
}): ProjectHomeEnvironment {
  if (options.hasConfig === false) {
    return {
      connection: { phase: options.phase },
      serverConfig: null,
    };
  }
  const settings =
    options.coordinatorThreadId && options.projectId
      ? applyServerSettingsPatch(
          DEFAULT_SERVER_SETTINGS,
          buildCoordinatorPatch(
            DEFAULT_SERVER_SETTINGS,
            options.projectId,
            options.coordinatorThreadId,
          ),
        )
      : DEFAULT_SERVER_SETTINGS;
  return {
    connection: { phase: options.phase },
    serverConfig: {
      environment: {
        environmentId: envSupportedId,
        label: "Test Env",
        kind: "local-desktop",
        capabilities: {
          projectSettingsOverrides: options.supportsOverrides ?? true,
        },
      } as unknown as NonNullable<ProjectHomeEnvironment["serverConfig"]>["environment"],
      settings,
    },
  };
}

function makeUnlistedState(
  overrides: Partial<EnvironmentThreadState> & { deletedAt?: DateTime.Utc | null },
): EnvironmentThreadState {
  const { deletedAt, ...rest } = overrides;
  const data =
    deletedAt !== undefined
      ? Option.some({
          thread: { deletedAt },
        } as unknown as OrchestrationV2ThreadProjection)
      : (overrides.data ?? Option.none());
  return {
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    ...rest,
    data,
  };
}

describe("selectProjectHomeMember", () => {
  it("picks the first connected member whose environment supports projectSettingsOverrides", () => {
    const envs = new Map<EnvironmentId, ProjectHomeEnvironment>([
      [envDisconnectedId, makeEnvironment({ phase: "offline", supportsOverrides: true })],
      [envUnsupportedId, makeEnvironment({ phase: "connected", supportsOverrides: false })],
      [envSupportedId, makeEnvironment({ phase: "connected", supportsOverrides: true })],
      [envSupportedBackupId, makeEnvironment({ phase: "connected", supportsOverrides: true })],
    ]);

    const selection = selectProjectHomeMember(
      [projectDisconnected, projectUnsupported, projectSupported, projectSupportedBackup],
      (id) => envs.get(id),
    );

    expect(selection).toMatchObject({
      kind: "supported",
      member: projectSupported,
    });
  });

  it("returns unsupported when at least one member is connected with config and none support overrides", () => {
    const envs = new Map<EnvironmentId, ProjectHomeEnvironment>([
      [envDisconnectedId, makeEnvironment({ phase: "offline", supportsOverrides: true })],
      [envUnsupportedId, makeEnvironment({ phase: "connected", supportsOverrides: false })],
    ]);

    const selection = selectProjectHomeMember([projectDisconnected, projectUnsupported], (id) =>
      envs.get(id),
    );
    expect(selection).toEqual({ kind: "unsupported" });
  });

  it("returns disconnected when no member is connected with serverConfig", () => {
    const envs = new Map<EnvironmentId, ProjectHomeEnvironment>([
      [envDisconnectedId, makeEnvironment({ phase: "offline", hasConfig: false })],
      [envUnsupportedId, makeEnvironment({ phase: "connected", hasConfig: false })],
    ]);

    expect(
      selectProjectHomeMember([projectDisconnected, projectUnsupported], (id) => envs.get(id)),
    ).toEqual({ kind: "disconnected" });
    expect(selectProjectHomeMember([], () => undefined)).toEqual({ kind: "disconnected" });
  });
});

describe("resolveProjectCoordinatorState", () => {
  const supportedWithCoordinator = (threadId: ThreadId | null) => ({
    kind: "supported" as const,
    member: projectSupported,
    environment: makeEnvironment({
      phase: "connected",
      supportsOverrides: true,
      projectId: projectSupported.id,
      coordinatorThreadId: threadId,
    }),
  });

  it("propagates disconnected and unsupported member selections", () => {
    expect(
      resolveProjectCoordinatorState({
        selection: { kind: "disconnected" },
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: null,
        canUpdateSettings: true,
      }),
    ).toEqual({ kind: "disconnected" });

    expect(
      resolveProjectCoordinatorState({
        selection: { kind: "unsupported" },
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: null,
        canUpdateSettings: true,
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("returns exists when coordinator thread is present in shell and not deleted", () => {
    expect(
      resolveProjectCoordinatorState({
        selection: supportedWithCoordinator(coordinatorThreadId),
        shellBootstrapComplete: false,
        threadShell: { deletedAt: null },
        unlistedThreadDetail: null,
        canUpdateSettings: false,
      }),
    ).toEqual({ kind: "exists", threadId: coordinatorThreadId });
  });

  it("waits for shell bootstrap and unlisted detail before concluding stale on off-shell threads", () => {
    const selection = supportedWithCoordinator(coordinatorThreadId);

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: false,
        threadShell: null,
        unlistedThreadDetail: EMPTY_ENVIRONMENT_THREAD_STATE,
        canUpdateSettings: true,
      }),
    ).toEqual({ kind: "loading" });

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: makeUnlistedState({ status: "synchronizing" }),
        canUpdateSettings: true,
      }),
    ).toEqual({ kind: "loading" });

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: makeUnlistedState({ status: "live", deletedAt: null }),
        canUpdateSettings: false,
      }),
    ).toEqual({ kind: "exists", threadId: coordinatorThreadId });
  });

  it("surfaces unlisted thread load errors instead of overwriting a valid coordinator", () => {
    expect(
      resolveProjectCoordinatorState({
        selection: supportedWithCoordinator(coordinatorThreadId),
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: makeUnlistedState({
          status: "empty",
          error: Option.some("Network timeout"),
        }),
        canUpdateSettings: true,
      }),
    ).toEqual({ kind: "error", message: "Network timeout" });
  });

  it("detects stale deleted coordinator threads from shell or unlisted detail", () => {
    const selection = supportedWithCoordinator(coordinatorThreadId);

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: { deletedAt: "2026-01-01T00:00:00.000Z" },
        unlistedThreadDetail: null,
        canUpdateSettings: true,
      }),
    ).toEqual({ kind: "needs-create", staleThreadId: coordinatorThreadId });

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: makeUnlistedState({ status: "deleted" }),
        canUpdateSettings: true,
      }),
    ).toEqual({ kind: "needs-create", staleThreadId: coordinatorThreadId });

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: makeUnlistedState({
          status: "live",
          deletedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        }),
        canUpdateSettings: false,
      }),
    ).toEqual({ kind: "no-permission" });
  });

  it("handles missing coordinator threads based on updateSettings and createThread permissions", () => {
    const selection = supportedWithCoordinator(null);

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: null,
        canUpdateSettings: true,
        canCreateThread: true,
      }),
    ).toEqual({ kind: "needs-create", staleThreadId: null });

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: null,
        canUpdateSettings: false,
      }),
    ).toEqual({ kind: "no-permission" });

    expect(
      resolveProjectCoordinatorState({
        selection,
        shellBootstrapComplete: true,
        threadShell: null,
        unlistedThreadDetail: null,
        canUpdateSettings: true,
        canCreateThread: false,
      }),
    ).toEqual({ kind: "no-permission" });
  });
});
