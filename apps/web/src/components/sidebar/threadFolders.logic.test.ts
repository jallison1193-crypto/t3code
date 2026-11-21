import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { WORK_MODE_TAG } from "@t3tools/client-runtime/state/thread-mode";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ThreadSectionId, type ServerSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  canChangeThreadFolder,
  currentThreadFolder,
  resolveThreadFolderMembers,
  threadFolderHomeProblem,
  threadFolderMembershipRequest,
  threadFolderPatchApplied,
} from "./threadFolders.logic";

const home = EnvironmentId.make("home");
const remote = EnvironmentId.make("remote");
const sameId = ThreadId.make("same");
const localRef = scopeThreadRef(home, sameId);
const remoteRef = scopeThreadRef(remote, sameId);
const localShell = { environmentId: home, id: sameId, title: "Local", deletedAt: null };
const remoteShell = {
  environmentId: remote,
  id: sameId,
  title: "Remote",
  deletedAt: null,
  tags: [WORK_MODE_TAG],
};
const localKey = scopedThreadKey(localRef);
const remoteKey = scopedThreadKey(remoteRef);
const shells = new Map([
  [localKey, localShell],
  [remoteKey, remoteShell],
]);
const bothSources = new Set([home, remote]);
const inbox = ThreadSectionId.make("eec6c5bb-6bdc-4db9-b4fd-eb647e557159");
const reading = ThreadSectionId.make("4def981a-0a8d-40b5-bd10-8a99c6d212f9");

describe("thread folders", () => {
  it("resolves matching thread IDs by source and filters resolved rows by mode", () => {
    const members = [localRef, remoteRef];
    const resolve = (mode: "all" | "code" | "work") =>
      resolveThreadFolderMembers(members, shells, bothSources, new Set(), mode).map(
        ({ ref, thread }) => [ref, thread?.title],
      );
    expect(resolve("all")).toEqual([
      [localRef, "Local"],
      [remoteRef, "Remote"],
    ]);
    expect(resolve("code")).toEqual([[localRef, "Local"]]);
    expect(resolve("work")).toEqual([[remoteRef, "Remote"]]);
  });

  it("retains an unresolved reference without using a stale or same-ID title", () => {
    const unavailable = { ref: remoteRef, key: remoteKey, thread: null };
    const scenarios: {
      shells: ReadonlyMap<
        string,
        Omit<typeof localShell, "deletedAt"> & { deletedAt: string | null }
      >;
      sources: ReadonlySet<EnvironmentId>;
      hidden: ReadonlySet<string>;
    }[] = [
      { shells, sources: new Set([home]), hidden: new Set<string>() },
      { shells, sources: bothSources, hidden: new Set([remoteKey]) },
      {
        shells: new Map([[localKey, localShell]]),
        sources: bothSources,
        hidden: new Set<string>(),
      },
      {
        shells: new Map([[remoteKey, { ...remoteShell, deletedAt: "2026-11-20" }]]),
        sources: bothSources,
        hidden: new Set<string>(),
      },
    ];
    for (const scenario of scenarios) {
      expect(
        resolveThreadFolderMembers(
          [remoteRef],
          scenario.shells,
          scenario.sources,
          scenario.hidden,
          "all",
        ),
      ).toEqual([unavailable]);
      expect(
        resolveThreadFolderMembers(
          [remoteRef],
          scenario.shells,
          scenario.sources,
          scenario.hidden,
          "work",
        ),
      ).toEqual([]);
    }
  });

  it("uses each home’s settings snapshot and targets only that home for an assignment", () => {
    const firstSettings = { [inbox]: { name: "Client work", members: [localRef] } };
    const otherSettings = { [inbox]: { name: "Client work", members: [remoteRef] } };
    const updatedSettings = {
      ...firstSettings,
      [reading]: { name: "Reading", members: [remoteRef] },
    };
    expect(currentThreadFolder(firstSettings, remoteRef)).toBeNull();
    expect(currentThreadFolder(otherSettings, remoteRef)).toBe(inbox);
    expect(currentThreadFolder(updatedSettings, remoteRef)).toBe(reading);
    expect(threadFolderMembershipRequest(home, remoteRef, reading)).toEqual({
      environmentId: home,
      input: { homeEnvironmentId: home, thread: remoteRef, sectionId: reading },
    });
  });

  it("allows removing an unavailable member from a writable home", () => {
    const sections = { [inbox]: { name: "Inbox" }, [reading]: { name: "Reading" } };
    expect(canChangeThreadFolder(inbox, null, sections, false)).toBe(true);
    expect(canChangeThreadFolder(inbox, reading, sections, false)).toBe(false);
    expect(canChangeThreadFolder(inbox, reading, {}, true)).toBe(false);
    expect(
      threadFolderHomeProblem({ online: true, canEdit: true, canAssign: true }, true),
    ).toBeNull();
    expect(threadFolderHomeProblem({ online: true, canEdit: false, canAssign: false }, true)).toBe(
      "read-only",
    );
    expect(threadFolderHomeProblem({ online: false, canEdit: true, canAssign: true }, false)).toBe(
      "offline",
    );
  });

  it("requires a create, rename, or delete response to reflect the requested patch", () => {
    const settings = (threadSections: ServerSettings["threadSections"]) => ({ threadSections });
    const before = settings({ [inbox]: { name: "Inbox", members: [remoteRef] } });
    const after = settings({ [inbox]: { name: "Client work", members: [remoteRef] } });
    const empty = settings({});
    expect(threadFolderPatchApplied(empty, inbox, "Inbox")).toBe(false);
    expect(threadFolderPatchApplied(before, inbox, "Client work")).toBe(false);
    expect(threadFolderPatchApplied(after, inbox, "Client work")).toBe(true);
    expect(threadFolderPatchApplied(after, inbox, null)).toBe(false);
    expect(threadFolderPatchApplied(empty, inbox, null)).toBe(true);
  });
});
