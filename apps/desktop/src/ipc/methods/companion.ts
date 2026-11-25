import { ScopedThreadRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopCompanionWindow from "../../window/DesktopCompanionWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Optional, so installing every handler does not require a host that has a companion window.
const withCompanionWindow = <E, R>(
  use: (
    service: DesktopCompanionWindow.DesktopCompanionWindow["Service"],
  ) => Effect.Effect<void, E, R>,
) =>
  Effect.serviceOption(DesktopCompanionWindow.DesktopCompanionWindow).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: use })),
  );

export const openCompanion = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPANION_OPEN_CHANNEL,
  payload: ScopedThreadRef,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.companion.open")(function* (thread) {
    yield* withCompanionWindow((service) => service.open(thread));
  }),
});

export const closeCompanion = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPANION_CLOSE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.companion.close")(function* () {
    yield* withCompanionWindow((service) => service.close);
  }),
});

export const minimizeCompanion = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPANION_MINIMIZE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.companion.minimize")(function* () {
    yield* withCompanionWindow((service) => service.minimize);
  }),
});

export const openCompanionThreadInMain = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPANION_OPEN_IN_MAIN_CHANNEL,
  payload: ScopedThreadRef,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.companion.openInMain")(function* (thread) {
    yield* withCompanionWindow((service) => service.openInMain(thread));
  }),
});
