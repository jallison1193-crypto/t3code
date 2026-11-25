import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DesktopCompanionComputerUse, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands } from "../../shortcuts/dispatcher";
import { localEnvironmentIdAtom } from "../../state/primaryEnvironment";
import {
  environmentThreadDetails,
  environmentThreadShells,
  runningThreadKeepAliveAtom,
} from "../../state/threads";
import {
  computerUseHoldRemaining,
  type ComputerUsePhase,
  nextComputerUsePhase,
  threadComputerUse,
} from "./companionComputerUse.logic";

// Only this computer's own threads: an agent on another machine never clicks on this screen.
// Reads the detail streams RunningThreadKeepAlive already holds, so nothing more is fetched.
const localComputerUseAtom = Atom.make((get) => {
  const environmentId: EnvironmentId | null = get(localEnvironmentIdAtom);
  if (environmentId === null) return null;
  const running = get(runningThreadKeepAliveAtom).get(environmentId) ?? new Set<ThreadId>();
  const threads = [...running].flatMap((threadId) => {
    const thread = get(
      environmentThreadDetails.quietThreadAtom(scopeThreadRef(environmentId, threadId)),
    );
    const use = thread === null ? null : threadComputerUse(threadId, thread.projection);
    return use === null ? [] : [use];
  });
  const waitingThreadIds = new Set(
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap((thread) =>
      thread.pendingRuntimeRequest === null ? [] : [thread.id],
    ),
  );
  return { environmentId, threads, waitingThreadIds };
}).pipe(Atom.withLabel("web-local-computer-use"));

/** Tells the desktop shell which thread is driving the computer, for the companion window. */
export function CompanionComputerUseCoordinator() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports thread activity to the desktop shell and times the end of each phase
  useEffect(() => {
    const companion = window.desktopBridge?.companion;
    if (companion === undefined) return;
    let phase: ComputerUsePhase | null = null;
    let reported: string | undefined;
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      const input = appAtomRegistry.get(localComputerUseAtom);
      const now = Date.now();
      phase = input === null ? null : nextComputerUsePhase({ ...input, previous: phase, now });
      const remaining = phase === null ? null : computerUseHoldRemaining(phase, now);
      if (remaining !== null) timer = window.setTimeout(update, remaining);
      const state: DesktopCompanionComputerUse | null =
        input === null || phase === null
          ? null
          : {
              thread: scopeThreadRef(input.environmentId, phase.threadId),
              waitingOnUser: phase.waitingOnUser,
            };
      const key = JSON.stringify(state);
      if (key === reported) return;
      reported = key;
      void companion.setComputerUse(state);
    };
    const unsubscribe = appAtomRegistry.subscribe(localComputerUseAtom, update);
    update();
    // Here and not in the chat view: a click-through window must be recoverable from any page.
    const unregister = registerCommands(
      {
        "companionWindow.toggleClickThrough": (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) void companion.toggleClickThrough();
        },
      },
      {
        when: (event) =>
          !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]")),
      },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      unregister();
    };
  }, []);
  return null;
}
