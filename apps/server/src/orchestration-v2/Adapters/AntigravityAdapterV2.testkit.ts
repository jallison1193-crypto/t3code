import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  type AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

const ANTIGRAVITY_REPLAY_PROVIDER = ProviderDriverKind.make("antigravity");
export const ANTIGRAVITY_REPLAY_INSTANCE_ID = ProviderInstanceId.make("antigravity");

function layerAntigravityProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const random = yield* SecureRandom.SecureRandom;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const replayGate = options.replayGate;
      const replayDir = yield* fileSystem
        .makeTempDirectoryScoped({
          prefix: `t3-orchestration-v2-antigravity-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId: ANTIGRAVITY_REPLAY_INSTANCE_ID,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (runtimeInput) =>
          makeAcpReplayRuntime({
            transcript,
            statusPath,
            scriptPath,
            childProcessSpawner,
            fileSystem,
            ...(replayGate === undefined ? {} : { replayGate }),
          })({
            runtimePolicy: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: runtimeInput.cwd,
            },
            clientInfo: { name: "t3code-test", version: "0.0.0" },
            ...runtimeInput,
            mcpServers: runtimeInput.mcpServers ?? [],
            clientCapabilities: runtimeInput.clientCapabilities ?? {},
            protocolLogging: runtimeInput.protocolLogging ?? {},
            onTermination: runtimeInput.onTermination ?? (() => Effect.void),
          }).pipe(Effect.provideService(SecureRandom.SecureRandom, random)),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
        continuationRequests,
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(layerHost, NodeServices.layer, NodeCrypto.layer, IdAllocator.layer),
    ),
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const AntigravityOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: ANTIGRAVITY_REPLAY_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeAcpReplayTranscript(transcript, ANTIGRAVITY_REPLAY_PROVIDER),
  makeProviderAdapterRegistryLayer: layerAntigravityProviderAdapterRegistryReplay,
};
