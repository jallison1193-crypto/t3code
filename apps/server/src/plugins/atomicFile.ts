// @effect-diagnostics nodeBuiltinImport:off - atomic temp-file writes generate random sibling paths.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export const writeFileAtomic = <E>(
  fs: FileSystem.FileSystem,
  filePath: string,
  content: string,
  errorFor: (cause: unknown) => E,
): Effect.Effect<void, E> => {
  const dir = NodePath.dirname(filePath);
  const base = NodePath.basename(filePath);
  const tempPath = NodePath.join(
    dir,
    `.${base}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
  );
  return fs.writeFileString(tempPath, content).pipe(
    Effect.andThen(fs.rename(tempPath, filePath)),
    Effect.tapError(() => fs.remove(tempPath).pipe(Effect.ignore)),
    Effect.mapError(errorFor),
  );
};
