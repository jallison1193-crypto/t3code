import type { EnvironmentPlugin } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { themeServerEnvironmentPluginsAtom } from "../state/server";
import { applyPluginCss } from "../themeCss";

const publishedPluginsAtom = Atom.make((get): ReadonlyArray<EnvironmentPlugin> => {
  const next = get(themeServerEnvironmentPluginsAtom);
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentPlugin>>());
  return previous !== null && Equal.equals(previous, next) ? previous : next;
}).pipe(Atom.keepAlive, Atom.withLabel("web-published-environment-plugins"));

export function startEnvironmentPluginCss(): () => void {
  applyPluginCss(appAtomRegistry.get(publishedPluginsAtom));
  return subscribeAtomChanges(publishedPluginsAtom, applyPluginCss);
}
