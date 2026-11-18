import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { buildCoordinatorPatch, coordinatorThreadIdOf } from "./coordinatorThread.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const thread1 = ThreadId.make("thread-1");
const thread2 = ThreadId.make("thread-2");
const threadB = ThreadId.make("thread-b");
const instanceId = ProviderInstanceId.make("codex");

describe("coordinatorThread", () => {
  it("reads coordinatorThreadId for a project and ignores missing values", () => {
    expect(coordinatorThreadIdOf(null, projectA)).toBeNull();
    expect(coordinatorThreadIdOf(DEFAULT_SERVER_SETTINGS, null)).toBeNull();
    expect(coordinatorThreadIdOf(DEFAULT_SERVER_SETTINGS, projectA)).toBeNull();

    const withCoordinator = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      buildCoordinatorPatch(DEFAULT_SERVER_SETTINGS, projectA, thread1),
    );
    expect(coordinatorThreadIdOf(withCoordinator, projectA)).toBe(thread1);
    expect(coordinatorThreadIdOf(withCoordinator, projectB)).toBeNull();
  });

  it("replaces an existing coordinator while preserving other project overrides and projects", () => {
    const seeded = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectA]: {
          projectInstructions: "Always run tests.",
          coordinatorThreadId: thread1,
          providerInstances: { [instanceId]: { enabled: false } },
        },
        [projectB]: {
          coordinatorThreadId: threadB,
        },
      },
    });

    const updated = applyServerSettingsPatch(
      seeded,
      buildCoordinatorPatch(seeded, projectA, thread2),
    );
    expect(coordinatorThreadIdOf(updated, projectA)).toBe(thread2);
    expect(updated.projectSettingsOverrides[projectA]).toEqual({
      projectInstructions: "Always run tests.",
      coordinatorThreadId: thread2,
      providerInstances: { [instanceId]: { enabled: false } },
    });
    expect(coordinatorThreadIdOf(updated, projectB)).toBe(threadB);
  });

  it("clears coordinatorThreadId while preserving sibling overrides", () => {
    const seeded = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectA]: {
          coordinatorInstructions: "Delegate reviews.",
          coordinatorThreadId: thread1,
        },
      },
    });

    const cleared = applyServerSettingsPatch(seeded, buildCoordinatorPatch(seeded, projectA, null));
    expect(coordinatorThreadIdOf(cleared, projectA)).toBeNull();
    expect(cleared.projectSettingsOverrides[projectA]).toEqual({
      coordinatorInstructions: "Delegate reviews.",
    });
  });

  it("removes the project override entry when coordinatorThreadId was the only override", () => {
    const seeded = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      buildCoordinatorPatch(DEFAULT_SERVER_SETTINGS, projectA, thread1),
    );
    expect(seeded.projectSettingsOverrides[projectA]).toEqual({
      coordinatorThreadId: thread1,
    });

    const cleared = applyServerSettingsPatch(seeded, buildCoordinatorPatch(seeded, projectA, null));
    expect(coordinatorThreadIdOf(cleared, projectA)).toBeNull();
    expect(cleared.projectSettingsOverrides[projectA]).toBeUndefined();
  });
});
