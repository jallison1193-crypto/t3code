# Bots

A bot is a named agent with its own goal, model, memory, triggers, and run history. Bots stay separate from your normal projects and threads so automated work does not clutter your day-to-day lists.

## Create a bot

1. Open the **Bots** tab in the sidebar, or open the command palette and choose **New bot**.
2. Enter a name, write the bot's goal (sent to every run of that bot), and pick a supported model (Claude, Codex, Antigravity, or Grok). New bots start with the first available supported model when one is set up.
3. Click **Create bot** to open the bot's page.

Each bot gets its own managed folder inside T3 Code's data directory and its own run history.

## Run a bot manually

Click **Run now** at the top of a bot's page to start a run right away with the bot's saved goal and model. T3 Code opens the new run when it starts.

- **Run now** is disabled while Bots are turned off, the bot is paused, or a daily limit is reached.
- It is also disabled while the page has unsaved changes. Click **Save changes** first.

## Add a trigger

On a bot's page, open the **Triggers** section and click **Add trigger**.

- Choose an interval, fixed time, one-time date, or webhook trigger, and describe what to do on that trigger (the bot's goal is always included).
- Triggers always follow the bot's model: new triggers use the bot's current model, and changing a bot's model updates all of its existing triggers.
- To get a webhook trigger's address, open its **...** menu and choose **Copy webhook URL**. The address contains a secret, so give it only to services that should be able to start the bot.
- By default, each trigger run starts a new thread under the bot so runs stay separate.
- Click any run under **Runs** (or expand the bot in the **Bots** sidebar tab) to read the run or reply to it. If a run needs your input or approval, or fails and you have not opened it, it also appears under **Needs you** when the Needs you section is on.

## Pause a bot

Click **Pause** in the top-right corner of a bot's page to stop its scheduled and webhook triggers without deleting them.

- Scheduled ticks that fall while the bot is paused are skipped and do not run as a backlog when you click **Resume**.
- Incoming webhook requests and manual runs are refused while the bot is paused.

## Turn Bots off

Go to **Settings -> Bots** and turn **Bots** off.

- Turning Bots off hides the **Bots** sidebar tab, the **New bot** command, and every bot's runs (including waiting runs in **Needs you**).
- Every bot trigger is blocked while Bots is off. Scheduled ticks are skipped without building a backlog, and webhooks and manual runs are refused.
- Your bots, triggers, and run history are kept intact. Turn **Bots** back on in **Settings -> Bots** to restore everything.

## Settings -> Bots

Open **Settings -> Bots** (or choose **Open bot settings** in the command palette) to manage bot defaults and review every bot in one place.

- **Default model for new bots:** Choose a supported model (Claude, Codex, Antigravity, or Grok) that new bots start with, or reset it to **Automatic** to pick the first available supported model.
- **Default daily limits for new bots:** Set the default limit mode and daily run or token caps copied into newly created bots, or reset them to the built-in defaults (24 runs and 2,000,000 tokens per day).
- **Defaults apply only to new bots:** Changing the default model or default daily limits does not modify bots that already exist.
- **Your bots:** Review each bot's status, model, and today's usage, pause or resume bots from the list, or select a bot to edit its settings in place.

## Safety gates

Bot threads always run through T3 Code's approval gate, even if a trigger or thread is set to a more permissive mode. The composer shows **Bot safety gate** instead of the permissions picker. T3 Code inspects each action before allowing it:

- **Allowed automatically:** Reads, file edits, read-only tools, web search tools, and commands that don't look like sending or deleting.
- **Ask before sending, deleting, or fetching URLs:** Actions that send messages, emails, posts, comments, pull requests, or non-GET HTTP requests, provider web-fetch tools (regardless of HTTP method), and commands or edits that delete files wait for your approval.
- **Ask before changing agent settings:** Edits or commands that touch agent settings (`.claude`, `.codex`, `.gemini`, `.grok`, `antigravity-acp`, `.agents`, `.cursor`, `.mcp.json`) wait for your approval, because those files can pre-approve tools.
- **Ask when unclear:** If T3 Code can't see what an action does, it waits for your approval.
- **Payments (blocked by default):** Tools and commands for paying, purchasing, checkout, ordering, transferring money, subscribing, or tipping are declined automatically by default. You can change an individual bot's **Payments** setting to **Ask me each time** to review payments one at a time instead.

Held approvals trigger phone alerts and appear in **Needs you** when that section is on. They offer only **Approve once** and **Decline**.

The gate judges each action by its tool name and command text. A script a bot writes and runs can still reach the network without asking, so give bots only the accounts and folders they need. Codex runs commands in an offline, read-only sandbox and asks before leaving it, and Codex's server-side web search is turned off for bot runs.

## Supported models

Bots require a provider that routes every tool, MCP call, and web fetch through T3 Code's approval gate (or disables ungated built-in tools on bot runs). Today, **Claude**, **Codex**, **Antigravity**, and **Grok** models are supported. Other providers (including Cursor, OpenCode, Pi, Kiro, Muse, fx, and ACP Registry) show why they are unsupported in the model picker, and runs configured with an unsupported provider fail closed unless you switch that bot to **Provider's own approvals (less safe)**.

## Provider's own approvals (less safe)

On a bot's page, the **Approvals** setting defaults to **T3 safety gate (recommended)**. You can switch an individual bot to **Provider's own approvals (less safe)** after confirming a warning.

- **What it does:** Lifts the supported-provider check for that bot so you can pick models from unsupported providers (such as Cursor). For supported providers, it changes nothing. T3 still runs the bot in approval-required mode, inspects every approval request that reaches T3, applies the bot's **Payments** setting (blocking paying by default), and enforces daily limits.
- **Why it is less safe:** Unsupported providers can run tools, MCP calls, or commands under their own settings without asking T3 first, so the bot may send, delete, or change things without waiting for your approval in T3. Bots using this setting show a **Less safe** badge on the bot page and in **Settings -> Bots**.
- **How to turn it off:** Open the bot's page, change **Approvals** back to **T3 safety gate (recommended)**, and click **Save changes**. If the bot still uses an unsupported model, it stops running until you pick a supported model.

## Payments

On a bot's page (or under **Settings -> Bots**), the **Payments** setting defaults to **Blocked (recommended)**. You can switch an individual bot to **Ask me each time** after confirming a warning.

- **What Ask me each time does:** When the safety gate spots a payment action, it holds the request instead of declining it automatically. The held approval card says it is a payment, shows the amount and recipient when T3 Code can read them from the request, appears in **Needs you** (when that section is on), and triggers phone alerts. You can choose **Approve once** or **Decline**; payments are never approved for the session. This applies in both **T3 safety gate** and **Provider's own approvals** modes for requests that reach T3 Code. Bots with this setting show a **Can ask to pay** badge on the bot page and in **Settings -> Bots**.
- **Wording-only limit:** T3 Code spots payments by tool name, command text, and request wording only. Browser checkouts, scripts, or tools without payment wording can slip past the payment check.
- **Recommended setup:** Give the bot a clearly named payment tool (for example, a tool whose name includes `pay`, `payment`, `checkout`, or `purchase`) and back it with a card that has its own spending limit.
- **How to turn it off:** Open the bot's page (or select the bot in **Settings -> Bots**), change **Payments** back to **Blocked (recommended)**, and click **Save changes**. Switching back needs no confirmation.

## Daily limits

Each bot has daily usage limits to cap automated spending and run volume:

- **Defaults:** 24 trigger runs per day and 2,000,000 tokens per day (`Runs and tokens`).
- **Modes:** Edit a bot's **Daily limits** in its settings to switch between **Runs and tokens**, **Runs only**, or **No limits**, or to adjust the daily caps.
- **What stops when a limit is reached:** Scheduled ticks are skipped without building a backlog, incoming webhooks are refused, and **Run now** at the top of the bot's page is disabled. Clicking **Run now** on a trigger and chatting in a bot thread still work.
- **Midnight reset:** Counts reset at local midnight on the server, and blocked triggers resume automatically without firing missed runs.
