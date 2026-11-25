import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type DesktopCompanionComputerUse,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
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
import {
  boundsDiffer,
  companionBounds,
  companionClickThrough,
  keepInWorkArea,
  type SavedCompanionBounds,
  SavedCompanionBoundsJson,
  savedBoundsFor,
} from "./DesktopCompanionWindow.logic.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

// Other always-on-top windows can stack above this one without any event to react to.
const KEEP_ON_TOP_INTERVAL = "2 seconds";
const GUARD_DEBOUNCE = "150 millis";
// Restoring inside the minimize event leaves Chromium not drawing: the window comes back black.
const RESTORE_DELAY = "150 millis";
const LOAD_ABORTED = -3;
// See-through enough to read what is under it while clicks pass to that.
const CLICK_THROUGH_OPACITY = 0.5;

const decodeSavedBounds = Schema.decodeEffect(SavedCompanionBoundsJson);
const encodeSavedBounds = Schema.encodeEffect(SavedCompanionBoundsJson);

const { logWarning } = makeComponentLogger("desktop-companion-window");

type Placement = Pick<
  ClientSettings,
  "companionWindowAlwaysOnTop" | "companionWindowPosition" | "companionWindowSize"
>;

interface Companion {
  readonly window: Electron.BrowserWindow;
  readonly apply: (placement: Placement) => void;
  readonly setClickThrough: (clickThrough: boolean) => void;
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
    /**
     * Follows computer use: opens the window on the thread doing it and lets clicks through
     * meanwhile. Null ends it, closing a window this opened.
     */
    readonly setComputerUse: (
      computerUse: DesktopCompanionComputerUse | null,
    ) => Effect.Effect<
      void,
      | ElectronWindow.ElectronWindowCreateError
      | DesktopClientSettings.DesktopClientSettingsReadError
    >;
    readonly toggleClickThrough: Effect.Effect<
      void,
      DesktopClientSettings.DesktopClientSettingsReadError
    >;
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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const openMutex = yield* Semaphore.make(1);
  const boundsMutex = yield* Semaphore.make(1);
  const boundsPath = path.join(environment.stateDir, "companion-window.json");
  let companion: Companion | undefined;
  let computerUse: DesktopCompanionComputerUse | null = null;
  let clickThroughOverride: boolean | null = null;
  // Only a window that computer use opened, and the user has not taken over, closes by itself.
  let autoOpened = false;

  const readSettings = clientSettings.get.pipe(
    Effect.map(Option.getOrElse(() => DEFAULT_CLIENT_SETTINGS)),
  );

  const wantsClickThrough = (settings: ClientSettings) =>
    companionClickThrough({
      override: clickThroughOverride,
      enabled: settings.companionWindowClickThrough,
      computerUse,
    });

  const syncClickThrough = (settings: ClientSettings) =>
    Effect.sync(() => companion?.setClickThrough(wantsClickThrough(settings)));

  // With nothing saved, or a file that cannot be read, the settings place the window.
  const readSavedBounds = fileSystem
    .readFileString(boundsPath)
    .pipe(Effect.flatMap(decodeSavedBounds), Effect.option);

  const writeSavedBounds = Effect.fn("desktop.companionWindow.writeSavedBounds")(
    function* (saved: SavedCompanionBounds) {
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(boundsPath, yield* encodeSavedBounds(saved));
    },
    boundsMutex.withPermits(1),
    Effect.catch((cause) => logWarning("could not save the companion window position", { cause })),
  );

  // Removed rather than only ignored, so choosing the old Position again does not bring it back.
  const forgetStaleBounds = Effect.fn("desktop.companionWindow.forgetStaleBounds")(
    function* (placement: Placement) {
      const saved = yield* readSavedBounds;
      if (Option.isNone(saved) || savedBoundsFor(saved.value, placement) !== null) return;
      yield* fileSystem.remove(boundsPath, { force: true });
    },
    boundsMutex.withPermits(1),
    Effect.catch((cause) => logWarning("could not reset the companion window position", { cause })),
  );

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
    restored: boolean,
  ): Companion => {
    let placement = initialPlacement;
    let home = initialBounds;
    let userPlaced = restored;
    let clickThrough = false;
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
      // macOS also reports moves the app made itself, and those are not worth saving.
      const byUser = userAdjusting;
      userAdjusting = false;
      userPlaced = true;
      home = window.getBounds();
      if (!byUser) return;
      void runPromise(
        writeSavedBounds({
          position: placement.companionWindowPosition,
          size: placement.companionWindowSize,
          ...home,
        }),
      );
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
      autoOpened = false;
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
      setClickThrough: (next) => {
        if (next === clickThrough || window.isDestroyed()) return;
        clickThrough = next;
        window.setIgnoreMouseEvents(next, { forward: true });
        // After the mouse call, which can rewrite the window style that holds the opacity.
        window.setOpacity(next ? CLICK_THROUGH_OPACITY : 1);
        // Keys the agent types must not land here.
        if (next && window.isFocused()) window.blur();
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
    const saved = Option.flatMapNullishOr(yield* readSavedBounds, (value) =>
      savedBoundsFor(value, placement),
    );
    const bounds = Option.match(saved, {
      onNone: () =>
        companionBounds({
          position: placement.companionWindowPosition,
          size: placement.companionWindowSize,
          workArea: display.workArea,
        }),
      // The display it was dragged to may be gone.
      onSome: (value) => keepInWorkArea(value, workAreaFor(value)),
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
    const created = attach(window, placement, bounds, Option.isSome(saved));
    companion = created;
    // Clicking into it takes it over: it must not close under a half-typed message.
    window.on("focus", () => {
      autoOpened = false;
    });

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

  /** Puts the window on `thread` without taking focus, creating it if there is none. */
  const showThread = Effect.fn("desktop.companionWindow.showThread")(function* (
    thread: ScopedThreadRef,
    settings: ClientSettings,
  ) {
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
  });

  return DesktopCompanionWindow.of({
    open: Effect.fn("desktop.companionWindow.open")(function* (thread) {
      if (yield* Ref.get(desktopState.quitting)) return;
      const settings = yield* readSettings;
      if (!settings.companionWindowEnabled) return;
      // Asked for by hand: it takes clicks, and stays until closed.
      clickThroughOverride = false;
      autoOpened = false;
      yield* showThread(thread, settings);
      yield* syncClickThrough(settings);
    }, openMutex.withPermits(1)),
    setComputerUse: Effect.fn("desktop.companionWindow.setComputerUse")(function* (next) {
      if (yield* Ref.get(desktopState.quitting)) return;
      const previous = computerUse;
      computerUse = next;
      // A toggle lasts until a phase starts or ends.
      if ((previous === null) !== (next === null)) clickThroughOverride = null;
      const settings = yield* readSettings;
      if (next === null) {
        if (autoOpened && settings.companionWindowAutoHide) yield* close;
      } else if (
        settings.companionWindowEnabled &&
        settings.companionWindowAutoOpen &&
        // Not on every report, so that closing it during a phase sticks.
        (previous?.thread.threadId !== next.thread.threadId ||
          previous.thread.environmentId !== next.thread.environmentId)
      ) {
        const absent = companion === undefined || companion.window.isDestroyed();
        yield* showThread(next.thread, settings);
        if (absent) autoOpened = true;
      }
      yield* syncClickThrough(settings);
    }, openMutex.withPermits(1)),
    toggleClickThrough: Effect.gen(function* () {
      const settings = yield* readSettings;
      clickThroughOverride = !wantsClickThrough(settings);
      yield* syncClickThrough(settings);
    }).pipe(
      openMutex.withPermits(1),
      Effect.withSpan("desktop.companionWindow.toggleClickThrough"),
    ),
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
        yield* forgetStaleBounds(settings);
        if (!settings.companionWindowEnabled) yield* close;
        else if (companion !== undefined && !companion.window.isDestroyed()) {
          companion.apply(settings);
          yield* syncClickThrough(settings);
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
