import { PluginManifest, PluginSettingEntry } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const decodeManifest = Schema.decodeUnknownExit(PluginManifest);
const decodeSettingEntry = Schema.decodeUnknownExit(PluginSettingEntry);

describe("PluginManifest worker decoding", () => {
  it("accepts a valid worker manifest with schedule, folders, and network", () => {
    const result = decodeManifest({
      name: "vault-sync",
      displayName: "Vault Sync",
      worker: {
        entry: "./worker.mjs",
        everyMinutes: 15,
        folders: [
          { id: "vault", label: "Obsidian vault folder", access: "write" },
          { id: "notes", label: "Reference notes", access: "read" },
        ],
        network: false,
      },
    });
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.worker).toEqual({
        entry: "./worker.mjs",
        everyMinutes: 15,
        folders: [
          { id: "vault", label: "Obsidian vault folder", access: "write" },
          { id: "notes", label: "Reference notes", access: "read" },
        ],
        network: false,
      });
    }
  });

  it("accepts minimal worker manifest with omitted optional fields and empty folders", () => {
    expect(
      Exit.isSuccess(
        decodeManifest({
          name: "minimal-worker",
          worker: { entry: "./index.mjs" },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeManifest({
          name: "empty-folders",
          worker: { entry: "./worker.mjs", folders: [], everyMinutes: 5, network: true },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeManifest({
          name: "max-interval",
          worker: { entry: "./worker.mjs", everyMinutes: 1440 },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    { name: "non-mjs entry", worker: { entry: "./worker.js" } },
    { name: "nested entry", worker: { entry: "./sub/worker.mjs" } },
    { name: "dotfile entry", worker: { entry: "./.worker.mjs" } },
    { name: "escaping entry", worker: { entry: "../worker.mjs" } },
    { name: "interval below 5", worker: { entry: "./worker.mjs", everyMinutes: 4 } },
    { name: "interval above 1440", worker: { entry: "./worker.mjs", everyMinutes: 1441 } },
    { name: "non-integer interval", worker: { entry: "./worker.mjs", everyMinutes: 15.5 } },
    {
      name: "duplicate folder ids",
      worker: {
        entry: "./worker.mjs",
        folders: [
          { id: "vault", label: "One", access: "read" },
          { id: "vault", label: "Two", access: "write" },
        ],
      },
    },
    {
      name: "more than 4 folders",
      worker: {
        entry: "./worker.mjs",
        folders: [
          { id: "a", label: "A", access: "read" },
          { id: "b", label: "B", access: "read" },
          { id: "c", label: "C", access: "read" },
          { id: "d", label: "D", access: "read" },
          { id: "e", label: "E", access: "read" },
        ],
      },
    },
    {
      name: "folder label over 60 chars",
      worker: {
        entry: "./worker.mjs",
        folders: [{ id: "vault", label: "a".repeat(61), access: "read" }],
      },
    },
    {
      name: "multiline folder label",
      worker: {
        entry: "./worker.mjs",
        folders: [{ id: "vault", label: "Line 1\nLine 2", access: "read" }],
      },
    },
    {
      name: "invalid folder access",
      worker: {
        entry: "./worker.mjs",
        folders: [{ id: "vault", label: "Vault", access: "execute" }],
      },
    },
    {
      name: "invalid folder id slug",
      worker: {
        entry: "./worker.mjs",
        folders: [{ id: "Bad_Id", label: "Vault", access: "read" }],
      },
    },
  ])("rejects invalid worker manifest: $name", ({ worker }) => {
    expect(Exit.isFailure(decodeManifest({ name: "demo", worker }))).toBe(true);
  });

  it("decodes PluginSettingEntry with workerApproval and folders", () => {
    const decoded = decodeSettingEntry({
      enabled: true,
      workerApproval: "0123456789ab",
      folders: { vault: "/Users/josh/Vault" },
    });
    expect(Exit.isSuccess(decoded)).toBe(true);
    expect(
      Exit.isFailure(
        decodeSettingEntry({
          enabled: true,
          workerApproval: "not-a-hash",
        }),
      ),
    ).toBe(true);
  });
});
