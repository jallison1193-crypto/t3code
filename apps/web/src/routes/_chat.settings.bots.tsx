import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { BotsSettingsPage } from "../bots/BotsSettingsPage";

function SettingsBotsRoute() {
  const { bot, env } = Route.useSearch();
  return <BotsSettingsPage selectedBotId={bot} selectedEnvironmentId={env} />;
}

export const Route = createFileRoute("/_chat/settings/bots")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.bot === "string" && raw.bot.trim().length > 0
      ? { bot: ProjectId.make(raw.bot.trim()) }
      : {}),
    ...(typeof raw.env === "string" && raw.env.trim().length > 0
      ? { env: EnvironmentId.make(raw.env.trim()) }
      : {}),
  }),
  component: SettingsBotsRoute,
});
