# Visual replies and MCP apps

Agents can render self-contained HTML visuals (charts, diagrams, tables, image collages, mockups) and interactive MCP Apps inline in a thread on web, desktop, and mobile.

## Visual replies (HTML renders)

Ask an agent for a visual (e.g. "show this as a chart" or "make a collage of these screenshots"). The rendered page appears above the agent's reply, adapts to your light/dark theme, and runs sandboxed away from your T3 Code session.

- **Local images**: Embedded when published so they stay intact even if the original files move or are deleted.
- **Preview browser**: Before publishing, agents verify their visual with T3 Code's bundled headless Chromium (~120 MB one-time download, shared with [remote browser tabs](./remote-access.md#browser-host-setup)).
- **Network restrictions**: Previews can load public CDN assets but block private/local-network IPs. If Clash/Mihomo fake-IP DNS causes CDN loads to fail, inline the resource, add the host to `fake-ip-filter`, or switch proxy DNS to `redir-host`.

## Find visual replies

On web and desktop, open **Library** from the sidebar to find pages across your environments. Open a project's **Library** tab to see pages from that project. When Work mode is on or you have Work threads, use the **All**, **Code**, or **Work** filter to narrow by the source thread's mode.

Select a page to open it full screen, or use **Open source thread** to return to the conversation. From a page's menu, you can pin it to the top of the library, rename it (leave the name blank to restore the original title), or choose **Ask for changes** (also available in the full-screen preview) to open its source thread with a draft prompt ready to edit. When the library shows **Load more**, it can still find pages further back. A notice lists environments it could not search. Agents can also list, pin, unpin, and rename pages in the library.

Switch to **Files** to browse files threads wrote or edited, newest first, across the same mode and project filters. Select a file to view it in its source thread's file viewer (a file outside the workspace opens the thread instead), or use **Open source thread** to jump to the conversation.

## MCP apps

MCP servers supporting the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard render interactive UIs directly below their tool calls (supported on Codex and Claude Code 2.1.301+ on up-to-date T3 servers).

- **Safety**: T3 Code asks before an MCP app runs non-read-only server tools, posts messages to the thread, opens links (mobile), or saves files. Navigating away from its own page stops the app.
- **Session requirement**: Apps remain viewable after a turn ends, but interacting with them requires the thread's agent session to be running.
- **Full screen**: Expand an app full screen and press `Esc` (or the corner button) to return to the thread.
