import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";
import { msg } from "gt-i18n";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronCompanionWindow from "../electron/ElectronCompanionWindow.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { m } from "../i18n/messages.ts";
import { CLIENT_SETTINGS_CHANGED_CHANNEL, COMPANION_SHOW_THREAD_CHANNEL } from "../ipc/channels.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { boundsDiffer, companionBounds, keepInWorkArea } from "./DesktopCompanionWindow.logic.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

// Other always-on-top windows can stack above this one without any event to react to.
const KEEP_ON_TOP_INTERVAL = "2 seconds";
const GUARD_DEBOUNCE = "150 millis";
// Restoring inside the minimize event leaves Chromium not drawing: the window comes back black.
const RESTORE_DELAY = "150 millis";
const LOAD_ABORTED = -3;

const { logWarning } = makeComponentLogger("desktop-companion-window");

type Placement = Pick<
  ClientSettings,
  "companionWindowAlwaysOnTop" | "companionWindowPosition" | "companionWindowSize"
>;

interface Companion {
  readonly window: Electron.BrowserWindow;
  readonly apply: (placement: Placement) => void;
  readonly show: () => void;
  readonly minimize: () => void;
}

export class DesktopCompanionWindow extends Context.Service<
  DesktopCompanionWindow,
  {
    /** Opens the window on `thread`, or moves the open one to it. Nothing when turned off. */
    readonly open: (
      thread: ScopedThreadRef,
    ) => Effect.Effect<
      void,
      | ElectronWindow.ElectronWindowCreateError
      | DesktopClientSettings.DesktopClientSettingsReadError
    >;
    readonly close: Effect.Effect<void>;
    readonly minimize: Effect.Effect<void>;
    /** Raises the main window on `thread`. */
    readonly openInMain: (
      thread: ScopedThreadRef,
    ) => Effect.Effect<void, DesktopWindow.DesktopWindowError>;
    /** Follows saved settings, and tells the app window that did not save them to re-read. */
    readonly applyClientSettings: (
      settings: ClientSettings,
      senderId: number | null,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopCompanionWindow") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const companionWindow = yield* ElectronCompanionWindow.ElectronCompanionWindow;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const openMutex = yield* Semaphore.make(1);
  let companion: Companion | undefined;

  const cancel = (fiber: Fiber.Fiber<unknown> | undefined) => {
    if (fiber !== undefined) runFork(Fiber.interrupt(fiber));
  };

  const later = (delay: typeof GUARD_DEBOUNCE | typeof RESTORE_DELAY, task: () => void) =>
    runFork(Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(task))));

  const workAreaFor = (bounds: Electron.Rectangle) =>
    Electron.screen.getDisplayMatching(bounds).workArea;

  /** Wires up one companion window: where it sits, how it stays on top, and how it is dismissed. */
  const attach = (
    window: Electron.BrowserWindow,
    initialPlacement: Placement,
    initialBounds: Electron.Rectangle,
  ): Companion => {
    let placement = initialPlacement;
    let home = initialBounds;
    let userPlaced = false;
    let userAdjusting = false;
    let userMinimized = false;
    let shown = false;
    let pinFiber: Fiber.Fiber<unknown> | undefined;
    let guardFiber: Fiber.Fiber<unknown> | undefined;
    let restoreFiber: Fiber.Fiber<unknown> | undefined;

    const put = (bounds: Electron.Rectangle) => {
      home = bounds;
      if (window.isDestroyed() || window.isMinimized()) return;
      window.setResizable(true);
      window.setBounds(bounds);
      window.setResizable(placement.companionWindowSize !== "small");
      // The OS may clamp or round; accepting that keeps the guard from fighting it forever.
      home = window.getBounds();
    };

    const keepOnTop = () => {
      // A focused window is already on top, and raising it again would cover its own menus.
      if (window.isDestroyed() || !window.isVisible() || window.isFocused()) return;
      window.setAlwaysOnTop(true, "screen-saver");
      window.moveTop();
    };

    const syncPin = () => {
      cancel(pinFiber);
      pinFiber = undefined;
      if (window.isDestroyed()) return;
      window.setAlwaysOnTop(placement.companionWindowAlwaysOnTop, "screen-saver");
      if (!placement.companionWindowAlwaysOnTop || !shown || userMinimized) return;
      pinFiber = runFork(
        Effect.sync(keepOnTop).pipe(Effect.repeat(Schedule.spaced(KEEP_ON_TOP_INTERVAL))),
      );
    };

    const scheduleGuard = () => {
      cancel(guardFiber);
      guardFiber = later(GUARD_DEBOUNCE, () => {
        if (window.isDestroyed() || window.isMinimized() || userAdjusting) return;
        if (boundsDiffer(window.getBounds(), home)) put(home);
      });
    };

    const rememberUserBounds = () => {
      userAdjusting = false;
      userPlaced = true;
      home = window.getBounds();
    };

    const onDisplaysChanged = () => {
      if (window.isDestroyed()) return;
      const workArea = workAreaFor(home);
      put(
        userPlaced
          ? keepInWorkArea(home, workArea)
          : companionBounds({
              position: placement.companionWindowPosition,
              size: placement.companionWindowSize,
              workArea,
            }),
      );
    };

    // Only Windows and macOS say when a move is the user's own, so only they can undo other moves.
    if (environment.platform === "win32" || environment.platform === "darwin") {
      const startUserAdjusting = () => {
        userAdjusting = true;
      };
      window.on("will-move", startUserAdjusting);
      window.on("will-resize", startUserAdjusting);
      window.on("moved", rememberUserBounds);
      window.on("resized", rememberUserBounds);
      window.on("move", scheduleGuard);
      window.on("resize", scheduleGuard);
    }

    Electron.screen.on("display-removed", onDisplaysChanged);
    Electron.screen.on("display-metrics-changed", onDisplaysChanged);

    window.on("always-on-top-changed", (_event, isOnTop) => {
      if (!isOnTop && placement.companionWindowAlwaysOnTop) {
        window.setAlwaysOnTop(true, "screen-saver");
      }
    });
    window.on("maximize", () => window.unmaximize());
    window.on("minimize", () => {
      if (userMinimized) return;
      // Something else minimized it, such as Show Desktop: put it back without taking focus.
      cancel(restoreFiber);
      restoreFiber = later(RESTORE_DELAY, () => {
        if (!window.isDestroyed()) window.showInactive();
      });
    });
    window.on("restore", () => {
      userMinimized = false;
      window.setSkipTaskbar(true);
      put(home);
      syncPin();
    });

    window.once("closed", () => {
      cancel(pinFiber);
      cancel(guardFiber);
      cancel(restoreFiber);
      Electron.screen.removeListener("display-removed", onDisplaysChanged);
      Electron.screen.removeListener("display-metrics-changed", onDisplaysChanged);
      companion = undefined;
      void runPromise(companionWindow.clear(window));
    });

    return {
      window,
      apply: (next) => {
        const moved =
          next.companionWindowPosition !== placement.companionWindowPosition ||
          next.companionWindowSize !== placement.companionWindowSize;
        const pinChanged = next.companionWindowAlwaysOnTop !== placement.companionWindowAlwaysOnTop;
        placement = next;
        if (pinChanged) syncPin();
        if (!moved) return;
        userPlaced = false;
        userAdjusting = false;
        put(
          companionBounds({
            position: next.companionWindowPosition,
            size: next.companionWindowSize,
            workArea: workAreaFor(home),
          }),
        );
      },
      show: () => {
        const firstShow = !shown;
        shown = true;
        userMinimized = false;
        window.setSkipTaskbar(true);
        window.showInactive();
        if (firstShow) {
          window.webContents.setBackgroundThrottling(true);
          syncPin();
        }
      },
      minimize: () => {
        userMinimized = true;
        syncPin();
        // Its taskbar button is the way back.
        window.setSkipTaskbar(false);
        window.minimize();
      },
    };
  };

  const installContextMenu = (window: Electron.BrowserWindow) => {
    window.webContents.on("context-menu", (event, params) => {
      event.preventDefault();
      if (!params.isEditable && params.selectionText === "") return;
      void runPromise(
        electronMenu.popupTemplate({
          window,
          template: [
            {
              role: "cut",
              label: m(msg("Cut", { $context: "Edit menu item" })),
              enabled: params.editFlags.canCut,
            },
            {
              role: "copy",
              label: m(msg("Copy", { $context: "Edit menu item" })),
              enabled: params.editFlags.canCopy,
            },
            {
              role: "paste",
              label: m(msg("Paste", { $context: "Edit menu item" })),
              enabled: params.editFlags.canPaste,
            },
            {
              role: "selectAll",
              label: m(msg("Select All", { $context: "Edit menu item" })),
              enabled: params.editFlags.canSelectAll,
            },
          ],
        }),
      );
    });
  };

  const create = Effect.fn("desktop.companionWindow.create")(function* (
    url: string,
    applicationUrl: string,
    placement: Placement,
  ) {
    const main = yield* electronWindow.main;
    const iconPaths = yield* assets.iconPaths;
    const icon = environment.platform === "darwin" ? Option.none() : iconPaths.ico;
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const display = Option.match(main, {
      onNone: () => Electron.screen.getPrimaryDisplay(),
      onSome: (window) => Electron.screen.getDisplayMatching(window.getBounds()),
    });
    const bounds = companionBounds({
      position: placement.companionWindowPosition,
      size: placement.companionWindowSize,
      workArea: display.workArea,
    });
    const window = yield* electronWindow.create(
      {
        ...bounds,
        show: false,
        frame: false,
        skipTaskbar: true,
        resizable: placement.companionWindowSize !== "small",
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        backgroundColor: shouldUseDarkColors ? "#000000" : "#ffffff",
        title: environment.displayName,
        ...Option.match(environment.platform === "linux" ? iconPaths.png : icon, {
          onNone: () => ({}),
          onSome: (path) => ({ icon: path }),
        }),
        webPreferences: {
          preload: environment.preloadPath,
          // Hidden-renderer throttling stalls first paint; re-enabled once shown.
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
      { auxiliary: true },
    );
    // Screenshots and screen capture leave it out; the user still sees it.
    window.setContentProtection(true);
    yield* rendererHistory.register(window.webContents, { surface: "companion" });
    // Desktop IPC must trust the window before its preload runs.
    yield* companionWindow.set(window);
    const created = attach(window, placement, bounds);
    companion = created;

    const contents = window.webContents;
    contents.setWindowOpenHandler(({ url: target }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(target))) {
        void runPromise(electronShell.openExternal(target));
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, target) => {
      if (DesktopWindow.isSameOriginRendererNavigation({ applicationUrl, navigationUrl: target })) {
        return;
      }
      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(target))) {
        void runPromise(electronShell.openExternal(target));
      }
    });
    installContextMenu(window);
    // Closing must not wait on the page, or a stuck window stays above everything.
    contents.on("will-prevent-unload", (event) => event.preventDefault());

    // A blank or dead companion is closed, so the next open starts a fresh one.
    const discard = (message: string, annotations: Record<string, unknown>) => {
      void runPromise(logWarning(message, annotations));
      if (!window.isDestroyed()) window.destroy();
    };
    contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== LOAD_ABORTED) {
        discard("companion window failed to load", { errorCode, errorDescription });
      }
    });
    contents.on("render-process-gone", (_event, details) => {
      discard("companion window render process gone", { reason: details.reason });
    });

    const revealFirst = () => {
      if (!window.isDestroyed() && !window.isVisible() && !window.isMinimized()) created.show();
    };
    window.once("ready-to-show", revealFirst);
    if (environment.platform === "linux") contents.once("did-finish-load", revealFirst);

    // It follows the app: with the main window gone there is nothing to follow.
    if (Option.isSome(main)) {
      const owner = main.value;
      const closeWithMain = () => {
        if (!window.isDestroyed()) window.close();
      };
      owner.once("closed", closeWithMain);
      window.once("closed", () => {
        if (!owner.isDestroyed()) owner.removeListener("closed", closeWithMain);
      });
    }

    void window.loadURL(url).catch(() => undefined);
  });

  const close = Effect.sync(() => {
    if (companion !== undefined && !companion.window.isDestroyed()) companion.window.close();
  }).pipe(Effect.withSpan("desktop.companionWindow.close"));

  const sendWhenLoaded = (window: Electron.BrowserWindow, channel: string, payload: unknown) =>
    Effect.sync(() => {
      const send = () => {
        if (!window.isDestroyed()) window.webContents.send(channel, payload);
      };
      if (window.webContents.isLoadingMainFrame()) {
        window.webContents.once("did-finish-load", send);
      } else {
        send();
      }
    });

  return DesktopCompanionWindow.of({
    open: Effect.fn("desktop.companionWindow.open")(function* (thread) {
      if (yield* Ref.get(desktopState.quitting)) return;
      const settings = Option.getOrElse(yield* clientSettings.get, () => DEFAULT_CLIENT_SETTINGS);
      if (!settings.companionWindowEnabled) return;
      const applicationUrl = getDesktopUrl(environment.isDevelopment);
      const url = `${applicationUrl}#/companion/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;
      if (companion === undefined || companion.window.isDestroyed()) {
        yield* create(url, applicationUrl, settings);
        return;
      }
      const { window } = companion;
      if (window.webContents.getURL() !== url) void window.loadURL(url).catch(() => undefined);
      // A window still loading for the first time shows itself when it has painted.
      if (window.isVisible() || window.isMinimized()) companion.show();
    }, openMutex.withPermits(1)),
    close,
    minimize: Effect.sync(() => {
      if (companion !== undefined && !companion.window.isDestroyed()) companion.minimize();
    }).pipe(Effect.withSpan("desktop.companionWindow.minimize")),
    openInMain: Effect.fn("desktop.companionWindow.openInMain")(function* (thread) {
      const main = yield* desktopWindow.revealOrCreateMain;
      yield* sendWhenLoaded(main, COMPANION_SHOW_THREAD_CHANNEL, thread);
    }),
    applyClientSettings: Effect.fn("desktop.companionWindow.applyClientSettings")(
      function* (settings, senderId) {
        if (!settings.companionWindowEnabled) yield* close;
        else if (companion !== undefined && !companion.window.isDestroyed()) {
          companion.apply(settings);
        }
        const windows = [yield* electronWindow.main, yield* companionWindow.current];
        for (const window of windows) {
          if (Option.isSome(window) && window.value.webContents.id !== senderId) {
            yield* sendWhenLoaded(window.value, CLIENT_SETTINGS_CHANGED_CHANNEL, null);
          }
        }
      },
    ),
  });
});

export const layer = Layer.effect(DesktopCompanionWindow, make);
