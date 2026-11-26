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
6. P5b MCP servers and hooks behind approval, agents. Done 2026-11-24 (T3 runs plugin MCP servers and serves their tools on its own `/mcp`, so every provider gets them; hooks and agents go to Claude through its own settings and `agents` options, other providers say not supported; one approval covers a plugin's MCP and hook config and any change asks again. Plugin folders are not passed to Claude natively, because Claude would then load their skills and MCP servers a second time).
7. P5c keybindings for plugin commands and panels.

- Later: project templates (instructions, memory skeleton, scripts, plugins).

## Milestone 6: Bots

Target: always-on agents like Grok Bot, OpenAI dots and Claude Duet, but on the user's own subscriptions and hardware.

- A bot is a named, long-lived agent: goal, model, memory, triggers (schedule, webhook, message), and a home environment (the laptop or a linked VPS as its "own computer").
- Bots live in their own sidebar tab; their working threads stay inside the bot. Approvals and questions still reach Needs you.
- Daily summary; approval gates for sending, paying and deleting, since bots read untrusted email and web pages.
- Builds on existing pieces: scheduled tasks, webhook automations, coordinator completion wakes, project memory, approvals, phone notifications, linked environments. Chat-app bridges (Telegram, iMessage, Slack) ship as plugins.
- Decided with Josh 2026-11-24:
  - Each bot is backed by a hidden project (scheduled tasks, memory and delegation all key on a project); bots stay out of the Projects list. Each trigger run gets its own thread that reports back to the bot.
  - Usage limits: runs per day and tokens per day by default; a per-bot setting switches to runs per day only or no limits. Hitting a limit pauses schedules and webhooks, never chatting with the bot.
  - Send and delete wait for Josh (Needs you plus a phone alert) and fail closed while he is away. Paying is blocked in M6 and added in a later stage.
  - Bots run on the laptop first; a linked VPS home comes later.
  - Signed-in browser: each bot gets its own browser profile and asks Josh to sign in once when a site needs a login or 2FA; never his everyday browser.
- Slices (Josh 2026-11-24: B1 and B2 are part of finishing T3ther and come after M5; B3 to B5 stay planned and are decided later):
  1. B1 bot core: named bot (goal, model, memory, schedule and webhook triggers), Bots sidebar tab, bot home with its runs. A Settings switch turns Bots off: the Bots tab and every bot surface disappear and bot triggers stop; turning it back on restores them unchanged.
  2. B2 safety: T3 pauses a bot's send and delete tool calls for approval and blocks pay; per-bot usage limits.
  3. B3 daily summary and VPS home.
  4. B4 bot browser profiles with sign-in handoff.
  5. B5 chat bridges (Telegram, Slack, iMessage) as plugins.

## Finishing pass: usability review

Asked for by Josh 2026-11-24, after B2 and before T3ther is called done. Walk every fork feature as a new user would, in the real app, and fix what is hidden or confusing.

- Every optional mode (Bots, Work mode, plugins) has a clear on/off switch in Settings and is easy to find when on.
- Nothing depends on a second hidden setting. The All, Code, Work and Bots tabs show in both sidebars (F2a).
- Known bot gaps found while testing B2: a trigger keeps the model it was created with, so changing the bot's Model on its home page doesn't reach existing triggers; webhook triggers have no Run now (on the bot home or in Settings > Scheduled tasks) and the bot home has no way to start a run by hand; the bot's Default model can resolve to a provider bots can't use.
- Empty states say what to do next; labels use plain words; every action has a way back.
- Each feature works end to end, including restart and a second client.

Walk done 2026-11-25 (Plugins not walked in the app: the sandbox had no plugins). Fixes in two slices:

1. F1 bots (done 2026-11-25): triggers follow the bot's model; Run now on the bot home (opens a prefilled draft); warning when the bot's model is on a provider bots can't use; bot wording in the trigger editor (New trigger, hide Project, Workspace, Destination and Model); webhook URL with Copy on the trigger card; bot pages keep the Bots tab and a Settings gear.
2. F2a sidebar and wording (done 2026-11-25: Bots and Work tabs in both sidebars, Work mode text and indicator, Library, folders, coordinator, "No active threads"); F2b (done 2026-11-25) a Plugins on/off switch, the Plugins empty state, and bot threads showing a fixed bot-safety label instead of "Full access", and bot threads hide git chrome in the details panel. Originally listed as F2 everything else: Bots and Work tabs reachable without the Projects sidebar setting; Work mode explains what it hides and shows that it is on; the Work tab hides projects with no Work threads; a Plugins on/off switch and an up-to-date empty state ("ask any agent"); Library called Library everywhere with an empty state that says what to do; distinct folder icons and an empty folders hint; the coordinator's empty state explains what it is for; the sidebar's "No active threads" points to the project's Threads board.

Left as is: the Threads board's Idle and Done columns (finished runs show as Idle until settled, same as every project).

3. F3 design consistency (asked for 2026-11-25). Upstream's design overhaul (PRs #24865 and #25778, the new design with no toggle since 2026-10-27) is already in the fork; its council never saw fork screens. Screenshot every fork surface with sandbox data next to the matching upstream screen and critique them (Opus plus a Sonnet reviewer for now; Codex and Neon when their quotas return). Keep T3 Code's fonts, icons, radii and tokens; change a fork screen only where it doesn't match the rest of the app. Don't tell reviewers a target score. Council run 2026-11-25 (Opus plus Sonnet, scores 5 to 8 of 10; Plugins and General settings closest to stock, the bot page and project tabs furthest). Fixes in two slices: F3a (done 2026-11-25) navigation, settings and Library (Bots-tab search, a visible way into project home, one "project / view" header, Settings out of the project tabs, a page-local Library filter, stock empty states and rows, a coordinator icon distinct from bots, Work mode and Bots in their own settings section, "Run plugins"); F3b (done 2026-11-25) bot page and status (Run now really runs, unsaved-edit guard, webhook URL behind Copy, Delete in a menu, runs as a list, failed runs under Waiting on you with stock status labels, bot names on Scheduled tasks rows). Josh 2026-11-25: Work mode keeps its name; the Threads board "Since you were away" strip is now one counts line with Mark all seen, and digest cards carry the status dot. Deferred: a stable sidebar footer, the Library page container.

4. F4 Settings > Bots (Josh 2026-11-26). A Settings page laid out like Settings > Projects: general bot settings at the top (the Bots on/off switch moved from General, a default model for new bots, default daily limits for new bots instead of the fixed 24 runs and 2M tokens), then the user's bots with status, model, today's usage and pause/resume; picking a bot opens its settings in place. The bot home page and Settings > Bots share one settings component, and the bot home keeps its runs list. Settings search, a command palette entry, all locales and docs. Also asked for the same day: a Settings switch that hides the projects sidebar's Needs you section (waiting threads still show under their projects).
   - Later, not in F4: per-bot notification settings, and a switch for whether waiting bot runs appear in Needs you.
5. B3 bots on more providers (Josh 2026-11-26, needed before a public release): Antigravity and Grok must be supported; other providers (such as Cursor) only if they pass the same test. Bots stay fail-closed: a provider is allowed only when every tool and MCP call in approval-required mode reaches T3's bot gate. Research first how other agent apps gate unattended agents. Then one shared conformance test per adapter (shell command, file delete, MCP send, web fetch must each be held or blocked), run on each provider's cheapest model, and the hard-coded Claude/Codex list in `packages/contracts/src/bot.ts` becomes a per-adapter capability. A provider that lets some calls skip its approval prompt either gets those tools turned off for bot runs or stays unsupported, with the reason shown on the bot page. Starts after the merge into `fork/main`.

Order to finish T3ther (2026-11-26): end-to-end check (done 2026-11-26: everything worked except Run plugins missing from Settings search, English bot reasons in other languages, and unsaved bot edits lost on leaving the page), one fix round (its findings plus the deferred sidebar footer and Library container), F4, a short final check, then merge `fork/m5-plugins` into `fork/main`; after that, new work branches from `fork/main` so the twice-weekly upstream sync reaches it. Codex computer-use testing of the companion window comes last.

## Milestone 7: Computer-use companion window (desktop)

Asked for 2026-11-25. A native version of Josh's T3 Mini prototype (`C:\Users\jalli\dev\t3-mini`, read only): a small always-on-top window that follows a thread while its agent controls the computer, so the user can watch thinking and tool calls, send a message or stop it, without covering the screen the agent is using.

- Desktop only (Electron). Web and mobile can't float a window over other apps; they keep the normal thread view.
- Hidden from screenshots with `BrowserWindow.setContentProtection(true)` (on Windows this excludes the window from capture), so the agent never sees it. The user does.
- Opens on its own when a thread in this environment starts a computer-use tool call, and hides a few seconds after computer use ends. It can also be opened and pinned by hand. Detection reads thread events the client already receives; no polling of the database.
- Always on top by default, with a minimize button.
- Settings > General (desktop only): on/off; position (right side, bottom right, bottom left, left side); size (small: an avatar-sized status bubble that expands on click; medium: a compact feed and composer; large: a full thread view); auto-open and auto-hide switches.
- Content is the existing web app on a compact route (thread timeline, composer, Stop), so every provider works and nothing is duplicated.
- M7a (done 2026-11-25): the window, the compact route, settings, and opening it by hand from the command palette, the thread menu or a keybinding. Not yet run in Electron; Josh tries it by hand. M7b (done 2026-11-25): opens on the thread that starts using the computer, click-through at half opacity while it does (toggle in the command palette), hides about 8 seconds after, remembers a dragged position. Detection reads the running-thread streams the main window already holds; subagents a provider runs inside its own turn are not detected.
- Prior art: Claude Desktop shrinks its chat into a panel docked at the top right during computer use; the ChatGPT and Codex desktop apps float a small avatar.

## Going public

Asked for 2026-11-18; do it when the fork goes public, and ask Josh before the repo rename or making anything public.

- A polished GitHub page: banner and name, one-line pitch, screenshots or a short GIF, what T3ther adds over T3 Code, every provider supported, the 9 UI languages, install for desktop, web and server, links to docs, contributing, MIT license with T3 Tools' copyright kept, and a "Built on T3 Code" credit (Josh 2026-11-25: no "unofficial" label; every fork is unofficial).
- Donations: `.github/FUNDING.yml` shows GitHub's Sponsor button. Use GitHub Sponsors and Buy Me a Coffee; a bio-site link can go under `custom`. Skip Cash App (it shows a personal payment handle and looks less trustworthy to strangers).

## Prompt recipes, not features

Model roles per project (who plans, builds, reviews) and cross-provider review need no code: write them in the project instructions and let the coordinator use `delegate_task`. Ship examples in `docs/fork/recipes/` instead of building them in.

## Status

- Toolchain solved: Vite+ `vp` provides Node 26.13.1 and pnpm 12.14.0.
- Fork: `jallison1193-crypto/t3code`, remote `myfork`. Integration branch `fork/main`, synced daily from upstream by `scripts/fork/sync-upstream.ps1`.
- M1, M2 and M3 done.
- M4 core done (2026-11-18): project home opens the coordinator, threads open beside it, Threads board, settings tabs, opt-in projects-first sidebar, mobile Threads screen. Mobile was checked by tests only; no emulator on the laptop yet.
- M4 project icons outside their group done (calm look). Suggested threads, Library and the digest moved into M4b.
- M4b done so far (2026-11-21): mode tag on threads, All/Code/Work sidebar filter, coding chrome hidden in Work, Work opens on project home, cross-server thread folders, HTML Library (global and per project). Added 2026-11-22: Library pin, rename and "Ask for changes" in the source thread; "Since you were away" digest on the project Threads board; MCP tools for folders and the Library (`t3_folder_read`/`_update`, `t3_library_read`/`_update`); a Files view in the Library listing files threads wrote or edited. Added 2026-11-23: Suggested threads (`t3_thread_suggest` shows a card in the chat; Start opens a prefilled draft). M4b is done. M5 plugins decided 2026-11-23; P1 and P2 done the same day (CSS plugins in Settings > Plugins; agents make them with `t3_plugin_write`, install card and Undo); P3 done the same day (plugin right panel tabs with saved state); P4 done 2026-11-24 (plugin server workers and the Obsidian vault sync test); P5a and P5b done 2026-11-24 (skills, slash commands, instructions, repo plugins, Claude Code plugin folders, MCP servers, hooks and agents); P5c done 2026-11-24 (keybindings for plugin commands and panels); M5 is done. M6 B1 done 2026-11-24 (bots as hidden projects with goal, model, schedule and webhook triggers, Bots tab, bot home, pause, and a Settings switch that hides Bots and blocks their triggers). B2 done 2026-11-25 (bots ask before sending, deleting or changing agent settings, never pay, run only on Claude or Codex, and stop at daily run and token limits). The finishing usability pass is next; B3 to B5 decided later.
- Upstream synced to `dd19bce823` on 2026-11-22 (367 commits). The fork's own Library migration 103 collided with upstream's 103 and was replaced by a service-created index.
- Order: M4b Work mode, then M5 plugins, then M6 bots. Mobile on hold.
- Working name: **T3ther** (a fork of T3 Code). The repo rename and the new README come when the fork goes public.
