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
