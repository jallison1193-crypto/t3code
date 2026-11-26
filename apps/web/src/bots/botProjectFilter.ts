import type { EnvironmentId, ProjectId, ServerSettings } from "@t3tools/contracts";

export type BotServerSettingsLike =
  | (Pick<ServerSettings, "projectSettingsOverrides"> & {
      readonly botsEnabled?: boolean | undefined;
    })
  | null
  | undefined;

export type BotSettingsLookup = (environmentId: EnvironmentId) => BotServerSettingsLike;

export function filterNonBotProjects<
  TProject extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(
  projects: ReadonlyArray<TProject>,
  getServerSettings: BotSettingsLookup,
): ReadonlyArray<TProject> {
  return projects.filter(
    (project) =>
      getServerSettings(project.environmentId)?.projectSettingsOverrides?.[project.id]?.bot ===
      undefined,
  );
}
