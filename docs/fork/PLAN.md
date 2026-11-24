# Fork plan: Claude-style Projects + Plugins

Base: upstream `pingdotgg/t3code` @ `ecb295516f` (2026-11-17). Research by two Gemini 4 Hydrogen xhigh agents, key paths spot-checked by Opus.

## Ground rules

- Upstream moves ~200 commits/day. Keep new logic in **new files**; touch hot files (`Orchestrator.ts`, `ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, `Sidebar.tsx`, `settings.ts`, `orchestrationV2.ts`) with 1-5 line hooks only.
- Additive, optional schema fields only, so older clients and servers still decode.
- No numbered DB migrations in the fork. Upstream owns the next ids, and a recorded fork name at an upstream id stops the server from starting. Use settings overrides, server settings, or an idempotent `CREATE ... IF NOT EXISTS` in the owning service (see `HtmlLibrary.ts`).
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
  - A collapsed project row still shows a dot or count when something inside needs the user.
  - A "Needs you" section at the top gathers waiting threads from every project, so the project layout never hides T3's cross-project triage.
  - Pinned section mixes projects and threads. Loose threads go in their own section below.
- Project color: through the project icon only (see Calm default look). No new schema.
- Organize: group threads inside a project by state (needs you, running, done), quick project switcher.
- Design pass done 2026-11-17; Josh approved the mockup. The wordmark reads T3ther (web sidebar, mobile header). The project home header names the view ("Coordinator", "Threads"), not the project, since the sidebar already shows it.
- Sidebar.tsx is a hot file: put the new mode in new `apps/web/src/components/sidebar/` files behind a small switch.

### Calm default look (decided 2026-11-18)

Compared with Linear, ChatGPT and platform guidance: color stays small. A project's color shows only through its project icon, and that icon appears wherever a thread shows outside its project's group (Needs you, Pinned, other threads, chat header). No stripes, tinted rows or colored backgrounds. Strong color is for status only. Users who want more restyle through plugins.

## Milestone 4b: Work mode

Target: Antigravity's Knowledge Work mode, ChatGPT Work and Claude Cowork, without splitting the app. Same agents, threads and projects in both modes.

- Mode: Code (today's T3) or Work. Work hides coding chrome (diffs, terminal, branch and worktree controls, checkpoints) and opens on the projects sidebar and project home. A Work project can be any folder, not only a repo.
- Each thread records the mode it was started in. Threads of both modes live in the same projects and open from either mode.
- Sidebar tabs at the top: **All | Code | Work | Bots** (Bots appears once M6 lands). All is the default. Projects filter by the threads they hold, not by a project-level mode. Anything waiting on the user stays in Needs you on every tab.
- Custom sections: user-named folders ("Taxes", "Client work") that hold threads, saved on the server like thread order so they follow the user across devices.
- Library (artifacts): one place for visual replies (HTML pages) and files threads produced, globally and per project, following the same All/Code/Work filter. Open full screen, jump to the source thread, pin, rename; "change this" continues in the source thread. Prominent in Work mode, one click away in Code mode.
- "Since you were away" digest and Suggested threads (from M4) land here.
- Candidates: personal memory shared across projects and providers; one connectors page (Gmail, Calendar, Drive) set up once for every provider.

## Mobile

On hold since 2026-11-18. Phones use the regular T3 Code app connected to a T3ther server, so server and contract changes stay additive and fork features degrade quietly there. The M4 mobile Threads screen stays but gets no more work.

## Milestone 5+: Plugins

Goal (Josh, 2026-11-17): ask an agent for a change and get a working plugin. "Make the sidebar denser", "add a pomodoro panel", "add a /standup command", "sync project memory to my vault". Plugins change the look, change the UX, and add real features, not only themes.

Decided with Josh (2026-11-23):

- Name: **plugins**, not mods. Claude Code and DeepSeek Harness use the word for the same bundle, so Claude Code compatibility means "a Claude Code plugin is a T3 plugin with fewer parts".
- Format: a folder with `.t3-plugin/plugin.json`, mirroring Claude Code's `.claude-plugin/plugin.json` so one folder can carry both. User plugins in `<T3 home>/userdata/plugins/`; repo plugins in `.t3/plugins/`, off until the user turns them on. Share as folder or git repo. Enable, disable and uninstall are always one click (reverse states); uninstall archives, never deletes.
- Approvals: an agent's first install of a plugin posts a card in the chat listing what it changes, with Install and Cancel. Later edits that add no new power apply at once with Undo. A new power that runs outside the sandbox (hooks, MCP servers, server worker, file or network access) asks again and names what it can touch.
- Research first: before each slice, study how DeepSeek Harness and Claude Code built that piece (read source where open) and put a short prior-art note in the brief.
- Look: reuse T3's theme path. Plugin CSS goes through the same fetch-stripping applier and limits as theme CSS and layers on top of the current theme. No second styling system.
- UX and content: named UI slots render plugin UI in the existing MCP Apps sandbox (`McpAppFrame.tsx` / `McpAppWebView.tsx`). Right panel tab first, then sidebar section and status line.
- Behavior: skills, slash commands, instructions, keybindings, MCP servers (approval-gated, proxied through T3's `/mcp`), hooks (approval-gated).
- Logic that needs files, network or schedules: plugin code in an isolated server worker with a small declared API, timed when it fits best (it gates the vault sync plugin).
- Claude Code plugin compatibility (skills, slash commands, MCP servers, hooks): after the core slices below.
- First real plugin: an agent-built panel as the end-to-end authoring test, then Obsidian vault sync once the worker exists.

Slices, in order:

1. P1 core and look: format, registry service, enable/disable/uninstall, plugin CSS delivered to clients, Settings > Plugins. Done 2026-11-23.
2. P2 authoring: MCP tools to list, read, create and edit plugins, the install card, Undo. Done 2026-11-23.
3. P3 right panel tab slot, then the agent-built panel. Done 2026-11-23 (an agent on Haiku built a working pomodoro tab).
4. P4 server worker, then Obsidian vault sync. Done 2026-11-24 (Node child process under `--permission` with user-picked folders and approval per powers change; an agent on Haiku built a vault sync plugin that wrote one note per project and an index into a test vault). Node 24 and Electron 44 lock folders but cannot block network yet, so Settings says so.
5. P5a skills, slash commands, instructions, repo plugins, Claude Code plugin folders. Done 2026-11-24 (T3 delivers these parts itself for every provider: instructions and a skill list in the project context, slash commands expanded before the prompt; repo plugins in `.t3/plugins/` stay off until turned on and stop applying after any change; an agent on Haiku built a working `/standup`).
6. P5b MCP servers and hooks behind approval, keybindings, agents, and passing approved plugin folders to Claude natively.

- Later: project templates (instructions, memory skeleton, scripts, plugins).

## Milestone 6: Bots

Target: always-on agents like Grok Bot, OpenAI dots and Claude Duet, but on the user's own subscriptions and hardware.

- A bot is a named, long-lived agent: goal, model, memory, triggers (schedule, webhook, message), and a home environment (the laptop or a linked VPS as its "own computer").
- Bots live in their own sidebar tab; their working threads stay inside the bot. Approvals and questions still reach Needs you.
- Daily summary; approval gates for sending, paying and deleting, since bots read untrusted email and web pages.
- Builds on existing pieces: scheduled tasks, webhook automations, coordinator completion wakes, project memory, approvals, phone notifications, linked environments. Chat-app bridges (Telegram, iMessage, Slack) ship as plugins.
- Open questions: an unattended signed-in browser for bots, and per-bot usage limits.

## Going public

Asked for 2026-11-18; do it when the fork goes public, and ask Josh before the repo rename or making anything public.

- A polished GitHub page: banner and name, one-line pitch, screenshots or a short GIF, what T3ther adds over T3 Code, every provider supported, the 9 UI languages, install for desktop, web and server, links to docs, contributing, MIT license with T3 Tools' copyright kept, and a clear "unofficial fork of T3 Code" note.
- Donations: `.github/FUNDING.yml` shows GitHub's Sponsor button. Use GitHub Sponsors and Buy Me a Coffee; a bio-site link can go under `custom`. Skip Cash App (it shows a personal payment handle and looks less trustworthy to strangers).

## Prompt recipes, not features

Model roles per project (who plans, builds, reviews) and cross-provider review need no code: write them in the project instructions and let the coordinator use `delegate_task`. Ship examples in `docs/fork/recipes/` instead of building them in.

## Status

- Toolchain solved: Vite+ `vp` provides Node 26.13.1 and pnpm 12.14.0.
- Fork: `jallison1193-crypto/t3code`, remote `myfork`. Integration branch `fork/main`, synced daily from upstream by `scripts/fork/sync-upstream.ps1`.
- M1, M2 and M3 done.
- M4 core done (2026-11-18): project home opens the coordinator, threads open beside it, Threads board, settings tabs, opt-in projects-first sidebar, mobile Threads screen. Mobile was checked by tests only; no emulator on the laptop yet.
- M4 project icons outside their group done (calm look). Suggested threads, Library and the digest moved into M4b.
- M4b done so far (2026-11-21): mode tag on threads, All/Code/Work sidebar filter, coding chrome hidden in Work, Work opens on project home, cross-server thread folders, HTML Library (global and per project). Added 2026-11-22: Library pin, rename and "Ask for changes" in the source thread; "Since you were away" digest on the project Threads board; MCP tools for folders and the Library (`t3_folder_read`/`_update`, `t3_library_read`/`_update`); a Files view in the Library listing files threads wrote or edited. Added 2026-11-23: Suggested threads (`t3_thread_suggest` shows a card in the chat; Start opens a prefilled draft). M4b is done. M5 plugins decided 2026-11-23; P1 and P2 done the same day (CSS plugins in Settings > Plugins; agents make them with `t3_plugin_write`, install card and Undo); P3 done the same day (plugin right panel tabs with saved state); P4 done 2026-11-24 (plugin server workers and the Obsidian vault sync test); P5 next.
- Upstream synced to `dd19bce823` on 2026-11-22 (367 commits). The fork's own Library migration 103 collided with upstream's 103 and was replaced by a service-created index.
- Order: M4b Work mode, then M5 plugins, then M6 bots. Mobile on hold.
- Working name: **T3ther** (unofficial fork of T3 Code). Repo rename and README disclaimer come when the fork goes public.
