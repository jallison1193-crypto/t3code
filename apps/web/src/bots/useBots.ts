import { AuthSettingsWriteScope } from "@t3tools/contracts";

import { useEnvironments } from "~/state/environments";
import { useEnvironmentsWithScope } from "~/state/session";
import { isAnyBotsEnabled } from "./bots.logic";

export function useAnyBotsEnabled(): boolean {
  const { environments } = useEnvironments();
  return isAnyBotsEnabled(environments);
}

export function useBotWritableEnvironments() {
  const { environments } = useEnvironments();
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  return environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig !== null &&
      environment.serverConfig.settings.botsEnabled !== false &&
      writable.has(environment.environmentId),
  );
}
