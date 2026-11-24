// @effect-diagnostics nodeBuiltinImport:off - state persistence uses lstat, path containment, and sha256 segment encoding alongside readThemeFileGuarded.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  PLUGIN_STATE_MAX_BYTES,
  PluginId,
  PluginStateError,
  type PluginStateScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { readThemeFileGuarded } from "../environmentTheme.ts";
import { writeFileAtomic } from "./atomicFile.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

const PLUGINS_STATE_DIR_NAME = "plugins-state";
const GLOBAL_STATE_FILE_NAME = "global.json";
const SAFE_PROJECT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const isPluginId = Schema.is(PluginId);
const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeEffect(UnknownJsonString);
const encodeUnknownJson = Schema.encodeEffect(UnknownJsonString);

interface PluginStateChangeEvent {
  readonly seq: number;
  readonly key: string;
  readonly value: unknown;
}

interface StateTarget {
  readonly key: string;
  readonly stateRoot: string;
  readonly pluginStateDir: string;
  readonly filePath: string;
}

export class PluginStateStore extends Context.Service<
  PluginStateStore,
  {
    readonly get: (
      pluginId: string,
      scope: PluginStateScope,
    ) => Effect.Effect<unknown, PluginStateError>;
    readonly set: (
      pluginId: string,
      scope: PluginStateScope,
      value: unknown,
    ) => Effect.Effect<void, PluginStateError>;
    /** Emits the current state value (or null) first, then each update for that plugin and scope. */
    readonly streamChanges: (
      pluginId: string,
      scope: PluginStateScope,
    ) => Stream.Stream<unknown, PluginStateError>;
  }
>()("t3/plugins/PluginStateStore") {}

const isInsideDirectory = (rootPath: string, candidatePath: string): boolean => {
  const relative = NodePath.relative(rootPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const lstatOrNull = (targetPath: string): NodeFS.Stats | null => {
  try {
    return NodeFS.lstatSync(targetPath);
  } catch {
    return null;
  }
};

const encodeProjectSegment = (projectId: string): string => {
  if (SAFE_PROJECT_SEGMENT_PATTERN.test(projectId)) return projectId;
  const bytes = Buffer.from(projectId, "utf8");
  let encoded = "";
  for (const byte of bytes) {
    const isSafe =
      (byte >= 48 && byte <= 57) ||
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      byte === 45 ||
      byte === 95;
    encoded += isSafe ? String.fromCharCode(byte) : `_${byte.toString(16).padStart(2, "0")}_`;
  }
  if (encoded.length === 0) return "_empty_";
  if (encoded.length <= 128) return encoded;
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 96)}__${digest}`;
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pluginRegistry = yield* PluginRegistry.PluginRegistry;

  const changes = yield* PubSub.unbounded<PluginStateChangeEvent>();
  const seqRef = yield* Ref.make(0);
  const writeSemaphore = yield* Semaphore.make(1);

  const resolveStateTarget = (
    pluginId: string,
    scope: PluginStateScope,
    operation: "get" | "set" | "subscribe",
  ): Effect.Effect<StateTarget, PluginStateError> => {
    if (!isPluginId(pluginId)) {
      return Effect.fail(new PluginStateError({ pluginId, operation, reason: "invalid_id" }));
    }
    let fileName: string;
    let key: string;
    if (scope === "global") {
      fileName = GLOBAL_STATE_FILE_NAME;
      key = `${pluginId}:global`;
    } else if (typeof scope.projectId === "string" && scope.projectId.trim().length > 0) {
      fileName = `project-${encodeProjectSegment(scope.projectId)}.json`;
      key = `${pluginId}:project:${scope.projectId}`;
    } else {
      return Effect.fail(new PluginStateError({ pluginId, operation, reason: "invalid_scope" }));
    }

    const stateRoot = NodePath.resolve(stateDir, PLUGINS_STATE_DIR_NAME);
    const pluginStateDir = NodePath.resolve(stateRoot, pluginId);
    const filePath = NodePath.resolve(pluginStateDir, fileName);
    if (
      !isInsideDirectory(stateRoot, pluginStateDir) ||
      !isInsideDirectory(pluginStateDir, filePath)
    ) {
      return Effect.fail(new PluginStateError({ pluginId, operation, reason: "invalid_scope" }));
    }
    return Effect.succeed({ key, stateRoot, pluginStateDir, filePath });
  };

  const assertNoSymlinks = (
    target: StateTarget,
    pluginId: string,
    operation: "get" | "set" | "subscribe",
    reason: "read_failed" | "write_failed",
  ): Effect.Effect<void, PluginStateError> => {
    for (const candidate of [target.stateRoot, target.pluginStateDir, target.filePath]) {
      if (lstatOrNull(candidate)?.isSymbolicLink() === true) {
        return Effect.fail(new PluginStateError({ pluginId, operation, reason }));
      }
    }
    return Effect.void;
  };

  // Untraced: called inside traced get/streamChanges spans.
  const readStateFile = Effect.fnUntraced(function* (
    target: StateTarget,
    pluginId: string,
    operation: "get" | "subscribe",
  ) {
    yield* assertNoSymlinks(target, pluginId, operation, "read_failed");
    const stat = lstatOrNull(target.filePath);
    if (stat === null) return null;
    if (!stat.isFile()) {
      return yield* new PluginStateError({ pluginId, operation, reason: "read_failed" });
    }
    const raw = readThemeFileGuarded(target.filePath, PLUGIN_STATE_MAX_BYTES);
    if (raw === null) {
      return yield* new PluginStateError({ pluginId, operation, reason: "read_failed" });
    }
    return yield* decodeUnknownJson(raw).pipe(
      Effect.mapError(
        (cause) => new PluginStateError({ pluginId, operation, reason: "read_failed", cause }),
      ),
    );
  });

  const get: PluginStateStore["Service"]["get"] = Effect.fn("PluginStateStore.get")(
    function* (pluginId, scope) {
      const target = yield* resolveStateTarget(pluginId, scope, "get");
      return yield* readStateFile(target, pluginId, "get");
    },
  );

  const set: PluginStateStore["Service"]["set"] = Effect.fn("PluginStateStore.set")(
    function* (pluginId, scope, value) {
      const target = yield* resolveStateTarget(pluginId, scope, "set");
      const { plugins } = yield* pluginRegistry.list.pipe(
        Effect.mapError(
          (cause) =>
            new PluginStateError({ pluginId, operation: "set", reason: "write_failed", cause }),
        ),
      );
      if (!plugins.some((plugin) => plugin.id === pluginId)) {
        return yield* new PluginStateError({ pluginId, operation: "set", reason: "not_found" });
      }

      const serialized = yield* encodeUnknownJson(value === undefined ? null : value).pipe(
        Effect.mapError(
          (cause) =>
            new PluginStateError({ pluginId, operation: "set", reason: "invalid_value", cause }),
        ),
      );
      if (Buffer.byteLength(serialized, "utf8") > PLUGIN_STATE_MAX_BYTES) {
        return yield* new PluginStateError({
          pluginId,
          operation: "set",
          reason: "state_too_large",
        });
      }
      const normalizedValue = yield* decodeUnknownJson(serialized).pipe(
        Effect.mapError(
          (cause) =>
            new PluginStateError({ pluginId, operation: "set", reason: "invalid_value", cause }),
        ),
      );

      const mapWriteError = (cause: unknown) =>
        new PluginStateError({ pluginId, operation: "set", reason: "write_failed", cause });

      yield* writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* assertNoSymlinks(target, pluginId, "set", "write_failed");
          yield* fs
            .makeDirectory(target.pluginStateDir, { recursive: true })
            .pipe(Effect.mapError(mapWriteError));
          yield* writeFileAtomic(fs, target.filePath, serialized, mapWriteError);
          const seq = yield* Ref.updateAndGet(seqRef, (current) => current + 1);
          yield* PubSub.publish(changes, { seq, key: target.key, value: normalizedValue }).pipe(
            Effect.asVoid,
          );
        }),
      );
    },
  );

  const streamChanges: PluginStateStore["Service"]["streamChanges"] = (pluginId, scope) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const target = yield* resolveStateTarget(pluginId, scope, "subscribe");
        const subscription = yield* PubSub.subscribe(changes);
        const [currentSeq, initialValue] = yield* writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const seq = yield* Ref.get(seqRef);
            const value = yield* readStateFile(target, pluginId, "subscribe");
            return [seq, value] as const;
          }),
        );
        return Stream.concat(
          Stream.make(initialValue),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.key === target.key && event.seq > currentSeq),
            Stream.map((event) => event.value),
          ),
        );
      }),
    );

  return PluginStateStore.of({ get, set, streamChanges });
});

export const layer = Layer.effect(PluginStateStore, make);
