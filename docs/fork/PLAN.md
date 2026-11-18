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

Built (differs from the first sketch):

- `coordinatorThreadId` and `coordinatorInstructions` live in project settings overrides, not a new DB column. Fork migrations would collide with upstream's numbered ones.
- Thread menu "Make project coordinator" / "Remove as coordinator" (web and mobile) pins the thread and shows a robot badge. Settings → Projects has coordinator instructions and a Clear row.
- Only the coordinator gets a `## Coordinator` block: a built-in lead (plan in memory, launch with `notifyOnFinish`, review results) plus the user's text.
- `t3_thread_launch` takes `notifyOnFinish: true`. `CompletionWakeService` queues one message to the launching thread when the child's run ends. Wakes are single-use and persisted in `<stateDir>/coordinator/completion-wakes.json`, so later messages in the child never cost a coordinator turn.

## Milestone 4: Project home view (Claude desktop Projects model)

Target: Claude desktop's redesigned Projects, where a project is one coordinator conversation that hands work to threads.

- Project home: replace the redirect in `apps/web/src/routes/projects.$projectKey.tsx` with `ProjectHomeView.tsx`. The coordinator conversation is the main view, and a coordinator thread is created on first visit when none is set, so there is no setup step. Mobile equivalent.
- Threads overview grouped by state like Claude: ready for review, waiting on you, working, idle, done.
- Side-by-side threads: clicking a launched thread, subagent or child thread opens it next to the coordinator with a "Threads > title" header, its live transcript and a steer box. It can be closed, minimized and opened full size. Reuse the right panel's `side-chat` surface (`SideChatPane.tsx` already embeds a full `ChatView`). Add a variant without the side-chat "Bring back" and delete actions instead of a new pane.
- Project settings laid out like Claude's dialog:
  - General: name and icon, "what do you want to work on" description, coordinator model, default thread model and effort, archive.
  - Memory: instructions, memory, knowledge files.
  - Environment: repos and folders every thread gets.
  - Reuse M1 and M2 rows and existing project fields; no new storage unless a setting has no home.
- Later in M4 or after: "Suggested threads" (the coordinator proposes work and the user starts it), a Library of files the threads produced, and a "Since you were away" digest of what finished, what waits on the user and what failed.

### Sidebar and color (with M4)

Josh's pain points: hard to organize, looks plain, projects feel buried.

- Projects-first sidebar mode (toggle; classic stays), laid out like Claude desktop's sidebar but in T3's styling:
  - Top nav: New, Search, Projects, Scheduled, plus T3's own pages.
  - One row per project with its color icon; clicking it opens the M4 coordinator view.
  - A project row expands to show only threads that are running or waiting on the user; the rest live in the project overview.
  - Pinned section mixes projects and threads. Loose threads go in their own section below.
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
- M1, M2 and M3 done. Next: M4 (Claude desktop Projects model).
- Working name: **T3ther** (unofficial fork of T3 Code). Repo rename and README disclaimer come when the fork goes public.
