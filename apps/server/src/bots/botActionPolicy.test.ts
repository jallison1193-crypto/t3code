import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type BotGateCapability,
  resolveBotGateCapability,
} from "@t3tools/contracts";

import {
  type BotActionClassification,
  type BotActionRequest,
  botHeldApprovalReason,
  classifyBotAction,
  tokenizeActionWords,
} from "./botActionPolicy.ts";

describe("classifyBotAction", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly request: BotActionRequest;
    readonly expected: BotActionClassification;
  }> = [
    // Pay (block)
    {
      name: "blocks pay tool name",
      request: { kind: "permission", toolName: "mcp__billing__pay_invoice" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks stripe checkout tool",
      request: { kind: "permission", toolName: "stripeCheckoutSession" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks purchase tool",
      request: { kind: "permission", toolName: "shop.purchase-item" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks subscribe tool",
      request: { kind: "permission", toolName: "subscribePlan" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks tip tool",
      request: { kind: "permission", toolName: "tip_creator" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks transfer money tool",
      request: { kind: "permission", toolName: "bank_transferMoney" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks place order tool",
      request: { kind: "permission", toolName: "place_order" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks send_payment with pay winning over send",
      request: { kind: "permission", toolName: "send_payment" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks stripe CLI charge creation",
      request: { kind: "command", command: "stripe charges create --amount=2000 --currency=usd" },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks curl POST to checkout endpoint",
      request: {
        kind: "command",
        command: 'curl -X POST -d \'{"plan":"pro"}\' https://api.example.com/v1/checkout',
      },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "blocks mcp elicitation about charging",
      request: {
        kind: "mcp-elicitation",
        appName: "Stripe",
        prompt: "Allow Stripe to charge $15.00?",
      },
      expected: { decision: "block", category: "pay" },
    },

    // Send (ask)
    {
      name: "asks for mcp__gmail__send_message",
      request: { kind: "permission", toolName: "mcp__gmail__send_message" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for camelCase sendMessage",
      request: { kind: "permission", toolName: "sendMessage" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for create_pr tool",
      request: { kind: "permission", toolName: "github__create_pr" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for camelCase createPR tool",
      request: { kind: "permission", toolName: "createPR" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for post/reply/forward/publish/share/invite/tweet/comment/email tools",
      request: { kind: "permission", toolName: "slack.postReply" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for comment_on_issue tool",
      request: { kind: "permission", toolName: "mcp__t3-code__comment_on_issue" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for email_report tool",
      request: { kind: "permission", toolName: "email_report" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for git push",
      request: { kind: "command", command: "git push origin main" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for gh pr create",
      request: { kind: "command", command: "gh pr create --title 'Update'" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for gh issue comment",
      request: { kind: "command", command: "gh issue comment 42 --body 'Looks good'" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for curl with request body",
      request: {
        kind: "command",
        command: "curl -d 'hello=world' https://hooks.example.com/notify",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for curl with non-GET method",
      request: { kind: "command", command: "curl -X POST https://api.example.com/items" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for wget with post data",
      request: { kind: "command", command: "wget --post-data='x=1' https://example.com/submit" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for Invoke-WebRequest with non-GET method",
      request: {
        kind: "command",
        command: "Invoke-WebRequest -Method Post -Uri https://example.com/hook",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for Invoke-RestMethod with -Body",
      request: {
        kind: "command",
        command: "Invoke-RestMethod -Uri https://example.com/hook -Body '{}'",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for sendmail",
      request: { kind: "command", command: "sendmail team@example.com < body.txt" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for mail",
      request: { kind: "command", command: "mail -s 'Daily summary' team@example.com" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks for chained command containing git push",
      request: { kind: "command", command: "git status && git push origin HEAD" },
      expected: { decision: "ask", category: "send" },
    },

    // Delete (ask)
    {
      name: "asks for delete tool",
      request: { kind: "permission", toolName: "mcp__drive__delete_file" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for trash/purge/drop/destroy/wipe/erase/remove tools",
      request: { kind: "permission", toolName: "trashEmail" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for rm command",
      request: { kind: "command", command: "rm -rf ./tmp-output" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for rmdir command",
      request: { kind: "command", command: "rmdir empty-dir" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for Windows del command",
      request: { kind: "command", command: "del old-report.txt" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for PowerShell Remove-Item",
      request: { kind: "command", command: "Remove-Item -Recurse -Force ./build" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for git clean",
      request: { kind: "command", command: "git clean -fd" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for git reset --hard",
      request: { kind: "command", command: "git reset --hard HEAD~1" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for git push --force as delete",
      request: { kind: "command", command: "git push --force origin main" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for nested bash -c rm",
      request: { kind: "command", command: 'bash -c "echo ok && rm -f notes.md"' },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for file-change that deletes a file",
      request: {
        kind: "file-change",
        toolName: "Edit",
        fileChanges: [{ operation: "delete", path: "notes.md" }],
      },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks for Codex file-change prompt that deletes a file",
      request: {
        kind: "file-change",
        prompt: "update notes.md\ndelete old.md",
      },
      expected: { decision: "ask", category: "delete" },
    },

    // Allow (word boundaries, reads, ordinary edits)
    {
      name: "allows sender_lookup on word boundaries",
      request: { kind: "permission", toolName: "sender_lookup" },
      expected: { decision: "allow" },
    },
    {
      name: "allows resend_count on word boundaries",
      request: { kind: "permission", toolName: "resend_count" },
      expected: { decision: "allow" },
    },
    {
      name: "allows read-only email listing tool",
      request: { kind: "permission", toolName: "mcp__gmail__list_messages" },
      expected: { decision: "allow" },
    },
    {
      name: "allows read-only order status lookup",
      request: { kind: "permission", toolName: "get_order_status" },
      expected: { decision: "allow" },
    },
    {
      name: "allows sort_order helper",
      request: { kind: "permission", toolName: "sort_order" },
      expected: { decision: "allow" },
    },
    {
      name: "allows file-read even when path mentions payment",
      request: { kind: "file-read", toolName: "Read", prompt: "payments/checkout.md" },
      expected: { decision: "allow" },
    },
    {
      name: "allows ordinary file-change update even when path mentions send",
      request: {
        kind: "file-change",
        toolName: "Edit",
        prompt: "update send_email.ts",
        fileChanges: [{ operation: "update", path: "send_email.ts" }],
      },
      expected: { decision: "allow" },
    },
    {
      name: "allows GET curl without body",
      request: { kind: "command", command: "curl -X GET https://api.example.com/status" },
      expected: { decision: "allow" },
    },
    {
      name: "allows plain wget download",
      request: { kind: "command", command: "wget https://example.com/feed.xml" },
      expected: { decision: "allow" },
    },
    {
      name: "allows Invoke-WebRequest GET",
      request: {
        kind: "command",
        command: "Invoke-WebRequest -Method Get -Uri https://example.com/feed.xml",
      },
      expected: { decision: "allow" },
    },
    {
      name: "allows ordinary read-only shell commands",
      request: { kind: "command", command: "git status && ls -la" },
      expected: { decision: "allow" },
    },
    {
      name: "asks before editing Claude settings in the bot folder",
      request: {
        kind: "file-change",
        toolName: "Write",
        fileChanges: [{ operation: "add", path: "C:\\bots\\mail\\.claude\\settings.local.json" }],
      },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "asks before a command writes Codex or Claude config",
      request: { kind: "command", command: "echo '{}' > ~/.codex/config.toml" },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "asks before writing an MCP config file",
      request: { kind: "command", command: "cp servers.json .mcp.json" },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "agent settings outrank delete",
      request: { kind: "command", command: "rm ~/.claude.json" },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "allows a path that only contains claude as a word",
      request: { kind: "command", command: "cat notes/claude-ideas.md" },
      expected: { decision: "allow" },
    },
    {
      name: "asks before a file change deletes via ACP prompt without structured fileChanges",
      request: { kind: "file-change", prompt: "delete /repo/secret.txt" },
      expected: { decision: "ask", category: "delete" },
    },
    {
      name: "asks before Claude WebFetch runs",
      request: {
        kind: "command",
        toolName: "WebFetch",
        prompt: "WebFetch: https://example.com/docs",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks before Claude WebFetch runs even when sibling toolName is absent",
      request: {
        kind: "command",
        prompt: "WebFetch: https://example.com/docs",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks before ACP fetch permission runs",
      request: {
        kind: "permission",
        prompt: "Fetch https://example.com/docs",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks before Antigravity read_url_content runs",
      request: {
        kind: "permission",
        toolName: "read_url_content",
        prompt: "Read https://example.com/docs",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks before Grok WebFetch permission runs",
      request: {
        kind: "permission",
        toolName: "WebFetch",
        prompt: "https://example.com/docs",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks before a bot opens a URL in T3's preview browser",
      request: {
        kind: "permission",
        toolName: "mcp_t3-code_preview_open",
        prompt: "Run mcp_t3-code_preview_open",
      },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks before preview_evaluate even when only the prompt names it",
      request: { kind: "permission", prompt: "Run mcp_t3-code_preview_evaluate" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "asks before a browser MCP navigates",
      request: { kind: "mcp-elicitation", toolName: "browser_navigate", prompt: "Navigate" },
      expected: { decision: "ask", category: "send" },
    },
    {
      name: "allows reading the preview page that is already open",
      request: { kind: "permission", toolName: "preview_snapshot", prompt: "Run preview_snapshot" },
      expected: { decision: "allow" },
    },
    {
      name: "keeps pay blocking above web fetch",
      request: {
        kind: "permission",
        toolName: "WebFetch",
        prompt: "Fetch https://stripe.com/checkout",
      },
      expected: { decision: "block", category: "pay" },
    },
    {
      name: "allows web search tools that reach the gate",
      request: {
        kind: "command",
        toolName: "WebSearch",
        prompt: "WebSearch: effect vitest docs",
      },
      expected: { decision: "allow" },
    },
    {
      name: "allows Antigravity search_web and Grok x_search",
      request: {
        kind: "permission",
        toolName: "search_web",
        prompt: "effect vitest docs",
      },
      expected: { decision: "allow" },
    },
    {
      name: "keeps curl GET shell command allowed",
      request: { kind: "command", command: "curl -s https://example.com/status" },
      expected: { decision: "allow" },
    },
    {
      name: "asks before editing .gemini, .grok, antigravity-acp, .agents, or .cursor settings",
      request: {
        kind: "file-change",
        toolName: "Edit",
        fileChanges: [{ operation: "modify", path: "/home/user/.gemini/settings.json" }],
      },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "asks before writing .grok config",
      request: {
        kind: "file-change",
        toolName: "Edit",
        fileChanges: [{ operation: "modify", path: "/home/user/.grok/settings.json" }],
      },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "asks before writing antigravity-acp config",
      request: {
        kind: "command",
        command: "cp custom.json ~/.t3/userdata/providers/antigravity/antigravity-acp/config.json",
      },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "asks before writing .agents rules",
      request: {
        kind: "file-change",
        toolName: "Edit",
        fileChanges: [{ operation: "modify", path: "/repo/.agents/rules.md" }],
      },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "asks before writing .cursor config",
      request: {
        kind: "file-change",
        toolName: "Edit",
        fileChanges: [{ operation: "modify", path: "/repo/.cursor/cli-config.json" }],
      },
      expected: { decision: "ask", category: "agent-settings" },
    },
    {
      name: "asks when a command request carries no command or tool name",
      request: { kind: "command" },
      expected: { decision: "ask", category: "unknown" },
    },
    {
      name: "asks when a permission request carries nothing to judge",
      request: { kind: "permission" },
      expected: { decision: "ask", category: "unknown" },
    },
    {
      name: "asks when a file change carries no paths or description",
      request: { kind: "file-change", toolName: "Edit" },
      expected: { decision: "ask", category: "unknown" },
    },
  ];

  it.each(cases)("$name", ({ request, expected }) => {
    expect(classifyBotAction(request)).toEqual(expected);
  });

  it("tokenizes identifier boundaries and builds held reasons", () => {
    expect(tokenizeActionWords("mcp__gmail__send_message")).toEqual([
      "mcp",
      "gmail",
      "send",
      "message",
    ]);
    expect(tokenizeActionWords("sendMessage")).toEqual(["send", "message"]);
    expect(tokenizeActionWords("createPR")).toEqual(["create", "pr"]);
    expect(tokenizeActionWords("sender_lookup")).toEqual(["sender", "lookup"]);
    expect(botHeldApprovalReason("send")).toBe("Bots ask before sending");
    expect(botHeldApprovalReason("delete")).toBe("Bots ask before deleting");
    expect(botHeldApprovalReason("agent-settings")).toBe("Bots ask before changing agent settings");
    expect(botHeldApprovalReason("pay")).toBe("Bots ask before paying");
  });

  it("resolves explicit botGate capability and fails closed on legacy fallback or missing snapshots", () => {
    const supported: BotGateCapability = { status: "supported" };
    const noCallback: BotGateCapability = {
      status: "unsupported",
      reasonCode: "no_approval_callback",
    };

    expect(
      resolveBotGateCapability({
        driver: ProviderDriverKind.make("antigravity"),
        botGate: supported,
      }),
    ).toEqual(supported);
    expect(
      resolveBotGateCapability({
        driver: ProviderDriverKind.make("cursor"),
        botGate: noCallback,
      }),
    ).toEqual(noCallback);

    // Old servers omitting `botGate` fall back to the legacy Claude/Codex rule.
    const legacyExpectations: ReadonlyArray<readonly [ProviderDriverKind, boolean]> = [
      [ProviderDriverKind.make("claudeAgent"), true],
      [ProviderDriverKind.make("codex"), true],
      [ProviderDriverKind.make("cursor"), false],
      [ProviderDriverKind.make("opencode"), false],
      [ProviderDriverKind.make("pi"), false],
      [ProviderDriverKind.make("antigravity"), false],
      [ProviderDriverKind.make("grok"), false],
      [ProviderDriverKind.make("kiro"), false],
      [ProviderDriverKind.make("fx"), false],
      [ProviderDriverKind.make("muse"), false],
      [ProviderDriverKind.make("acpRegistry"), false],
    ];
    for (const [driver, expected] of legacyExpectations) {
      const capability = resolveBotGateCapability({ driver });
      expect(capability.status === "supported").toBe(expected);
      if (!expected) {
        expect(capability).toEqual({
          status: "unsupported",
          reasonCode: "unverified_third_party_acp",
        });
      }
    }

    expect(resolveBotGateCapability(undefined)).toEqual({
      status: "unsupported",
      reasonCode: "provider_unavailable",
    });
    expect(resolveBotGateCapability(null)).toEqual({
      status: "unsupported",
      reasonCode: "provider_unavailable",
    });
  });
});
