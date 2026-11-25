# Bots

A bot is a named agent with its own goal, model, memory, triggers, and run history. Bots stay separate from your normal projects and threads so automated work does not clutter your day-to-day lists.

## Create a bot

1. Open the **Bots** tab in the sidebar, or open the command palette and choose **New bot**.
2. Enter a name, write the bot's goal (sent to every run of that bot), and optionally pick a model. If you leave the model on **Default model**, runs inherit your environment's default model.
3. Click **Create bot** to open the bot's page.

Each bot gets its own managed folder inside T3 Code's data directory and its own run history.

## Add a trigger

On a bot's page, open the **Triggers** section and click **Add trigger**.

- Choose an interval, fixed time, one-time date, or webhook trigger.
- By default, each trigger run starts a new thread under the bot so runs stay separate.
- Click any run under **Runs** (or expand the bot in the **Bots** sidebar tab) to read the run or reply to it. If a run needs your input or approval, it also appears under **Needs you**.

## Pause a bot

Click **Pause** in the top-right corner of a bot's page to stop its scheduled and webhook triggers without deleting them.

- Scheduled ticks that fall while the bot is paused are skipped and do not run as a backlog when you click **Resume**.
- Incoming webhook requests and manual runs are refused while the bot is paused.

## Turn Bots off

Go to **Settings -> General** and turn **Bots** off.

- Turning Bots off hides the **Bots** sidebar tab, the **New bot** command, and every bot's runs (including waiting runs in **Needs you**).
- Every bot trigger is blocked while Bots is off. Scheduled ticks are skipped without building a backlog, and webhooks and manual runs are refused.
- Your bots, triggers, and run history are kept intact. Turn **Bots** back on in **Settings -> General** to restore everything.

## Safety gates

Bot threads always run through T3 Code's approval gate, even if a trigger or thread is set to a more permissive mode. T3 Code inspects each action before allowing it:

- **Allowed automatically:** Reads, ordinary edits inside the bot's folder, and read-only tools.
- **Ask before sending or deleting:** Actions that send messages, emails, posts, comments, pull requests, or non-GET HTTP requests, as well as commands or edits that delete files, wait for your approval. Held approvals appear in **Needs you** and trigger phone alerts with only **Approve once** and **Decline** options.
- **Paying is blocked:** Tools and commands for paying, purchasing, checkout, ordering, transferring money, subscribing, or tipping are declined automatically.

## Supported models

Bots require a provider that routes every tool and MCP call through T3 Code's approval gate. Today, **Claude** and **Codex** models are supported. Runs configured with another provider fail closed with a notice prompting you to pick a Claude or Codex model.

## Daily limits

Each bot has daily usage limits to cap automated spending and run volume:

- **Defaults:** 24 trigger runs per day and 2,000,000 tokens per day (`Runs and tokens`).
- **Modes:** Edit a bot's **Limits** in its settings to switch between **Runs and tokens**, **Runs only**, or **No limits**, or to adjust the daily caps.
- **What stops when a limit is reached:** Scheduled ticks are skipped without building a backlog, and incoming webhooks are refused. Clicking **Run now** on a trigger and chatting in a bot thread still work.
- **Midnight reset:** Counts reset at local midnight on the server, and blocked triggers resume automatically without firing missed runs.
