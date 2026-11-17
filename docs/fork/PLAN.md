# Fork plan: Claude-style Projects + Mods

Base: upstream `pingdotgg/t3code` @ `ecb295516f` (2026-11-17). Research by two Gemini 4 Hydrogen xhigh agents, key paths spot-checked by Opus.

## Ground rules

- Upstream moves ~200 commits/day. Keep new logic in **new files**; touch hot files (`Orchestrator.ts`, `ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, `Sidebar.tsx`, `settings.ts`, `orchestrationV2.ts`) with 1-5 line hooks only.
- Additive, optional schema fields only, so older clients and servers still decode.
- Hit every surface (repo `AGENTS.md`): web, desktop, mobile, MCP tools for agents, contracts, i18n, reverse states.
- Check: `vp run check:changed` plus focused `vp test run <files>`. No repo-wide checks.

## Milestone 1: Project Instructions (no DB migration)

Text delivered to every thread in a project, any provider.

1. Add `projectInstructions` to `ProjectScopedServerSettingKey` (`packages/contracts/src/settings.ts`). Gets project override and `t3.json` resolution for free via `packages/shared/src/projectSettings.ts`.
2. Resolve it in `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`; add optional `projectInstructions` to `ProviderAdapterV2TurnInput` (`packages/provider-core/src/server/ProviderAdapter.ts`).
3. One shared formatter in a new `packages/provider-core/src/server/projectInstructions.ts` (wraps in `<project_instructions>`, size cap).
4. Per-adapter delivery, piggybacking where each adapter already places runtime instructions:
   - Claude: `systemPrompt.append` (session-start only; edits apply to new sessions).
   - Codex: `additionalContext`, chunked under the 4 KB per-entry cap.
   - OpenCode: `session.instructions.entry.put`.
   - Pi: `before_agent_start`.
   - Antigravity: `sessionSystemPromptAppend`.
   - ACP (Grok, Kiro, fx, registry), Cursor, Muse: existing `<t3_code_instructions>` prepend path; skip `/` commands; no double inject after compaction.
5. UI: textarea in `ProjectSettingsPanel.tsx` (web) and mobile project settings; i18n keys.
6. Tests: formatter unit test; one adapter delivery test per delivery style.

## Upstream sync (before M2)

- Daily scheduled job: fetch `origin` (upstream), rebase or merge the fork branches, run `vp run check:changed`, report conflicts and failures. Keeps drift small given upstream churn.

## Milestone 2: Project Memory and Knowledge

- File at `<T3 home>/userdata/projects/<projectId>/MEMORY.md` (shared across worktrees, never dirties git).
- New MCP toolkit `project_memory` (`read`, `append`, `replace_section`) registered in `McpHttpServer.ts`; HTTP/RPC route for UI editing.
- Inject a short pointer plus capped head of memory alongside project instructions.
- Knowledge files: docs, PDFs and notes added to `<T3 home>/userdata/projects/<projectId>/knowledge/`, searchable by any provider through the same toolkit (`knowledge_search`, `knowledge_read`). Not injected wholesale; the instructions point to the tools.

## Milestone 3: Coordinator thread

- Optional `coordinatorThreadId` on the project (contracts, `ProjectCommands.ts`, `ProjectStore.ts`, new migration).
- Pinned and badged in the sidebar; coordinator-only instruction block.
- `t3_thread_launch` gains optional `notifyThreadId`; a new completion-wake reactor (new file) uses `continuationRequests.offer`, like `delegate_task` already does.

## Milestone 4: Project home view

- Replace the redirect in `apps/web/src/routes/projects.$projectKey.tsx` with `ProjectHomeView.tsx`: coordinator, threads, instructions, memory, files. Mobile equivalent.
- "Since you were away" digest: what finished, what waits on the user, what failed.

### Sidebar and color (with M4)

Josh's pain points: hard to organize, looks plain, projects feel buried.

- Projects-first sidebar mode (toggle; classic stays): each project is a colored group with its coordinator pinned on top, then active threads, then a collapsed "older" fold. Loose threads in their own section below.
- Project color everywhere: reuse the existing `ProjectIconColor` palette (`packages/contracts/src/project.ts`); tint the group header, a thin rail on its thread rows, and the chat header. No new schema.
- Organize: group threads inside a project by state (needs you, running, done), quick project switcher.
- Design pass first: references from the vault's look-first list (app UI: Mobbin, Refero, Component Gallery), then a mockup for Josh before building.
- Sidebar.tsx is a hot file: put the new mode in new `apps/web/src/components/sidebar/` files behind a small switch.

## Milestone 5+: Mods

Phase 1 declarative `t3mod.json`: themes, skills, slash commands, instructions, MCP servers (approval-gated, proxied through T3's `/mcp`), hooks (approval-gated), panels rendered in the existing MCP Apps sandbox (`McpAppFrame.tsx` / `McpAppWebView.tsx`). User mods in T3 home; repo mods in `.t3/mods/`, disabled until approved. Share as folder or git repo.
Phase 2: code mods in an isolated worker process; persistent panels.
First real mod: Obsidian vault sync (project memory and status to the vault's project notes).
Later: project templates (instructions, memory skeleton, scripts, mods).

## Prompt recipes, not features

Model roles per project (who plans, builds, reviews) and cross-provider review need no code: write them in the project instructions and let the coordinator use `delegate_task`. Ship examples in `docs/fork/recipes/` instead of building them in.

## Status

- Toolchain solved: Vite+ `vp` provides Node 26.13.1 and pnpm 12.14.0.
- Fork: `jallison1193-crypto/t3code`, remote `myfork`. Integration branch `fork/main`, synced daily from upstream by `scripts/fork/sync-upstream.ps1`.
- M1 and M2 done and merged into `fork/main`. Next: M3.
- Working name: **T3ther** (unofficial fork of T3 Code). Repo rename and README disclaimer come when the fork goes public.
