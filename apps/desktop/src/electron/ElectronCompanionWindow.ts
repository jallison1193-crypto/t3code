import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

/**
 * Holds the companion window. Kept apart from DesktopCompanionWindow so DesktopIpc can trust the
 * window without depending on everything that drives it.
 */
export class ElectronCompanionWindow extends Context.Service<
  ElectronCompanionWindow,
  {
    readonly current: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    readonly set: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly clear: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronCompanionWindow") {}

const make = Effect.gen(function* () {
  const windowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

  return ElectronCompanionWindow.of({
    current: Effect.map(
      Ref.get(windowRef),
      Option.filter((window) => !window.isDestroyed()),
    ),
    set: Effect.fn("ElectronCompanionWindow.set")(function (window) {
      return Ref.set(windowRef, Option.some(window));
    }),
    clear: Effect.fn("ElectronCompanionWindow.clear")(function (window) {
      return Ref.update(
        windowRef,
        Option.filter((current) => current !== window),
      );
    }),
  });
});

export const layer = Layer.effect(ElectronCompanionWindow, make);
