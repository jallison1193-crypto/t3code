import type {
  OrchestrationV2FileChangeDetail,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "@t3tools/contracts";

export type BotActionDecision = "allow" | "ask" | "block";
export type BotHeldCategory = "send" | "delete" | "agent-settings" | "unknown";
export type BotActionCategory = BotHeldCategory | "pay";

export type BotActionClassification =
  | { readonly decision: "allow" }
  | { readonly decision: "ask"; readonly category: BotHeldCategory }
  | { readonly decision: "block"; readonly category: "pay" };

export const BOT_PAY_BLOCKED_FEEDBACK = "Paying is blocked for bots in T3ther.";

export const BOT_HELD_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve once" },
];

const BOT_HELD_APPROVAL_REASONS: Record<BotHeldCategory, string> = {
  send: "Bots ask before sending",
  delete: "Bots ask before deleting",
  "agent-settings": "Bots ask before changing agent settings",
  unknown: "Bots ask when T3 can't tell what an action does",
};

export function botHeldApprovalReason(category: BotHeldCategory): string {
  return BOT_HELD_APPROVAL_REASONS[category];
}

export interface BotActionRequest {
  readonly kind: ProviderRequestKind;
  readonly toolName?: string | null | undefined;
  readonly command?: string | null | undefined;
  readonly prompt?: string | null | undefined;
  readonly appName?: string | null | undefined;
  readonly fileChanges?:
    | ReadonlyArray<Pick<OrchestrationV2FileChangeDetail, "operation" | "path">>
    | undefined;
}

/**
 * Single word table for tool-name and prompt classification so future adjustments
 * stay in one place. Words are matched on identifier word boundaries (split on
 * `_`, `-`, `.`, `/`, `:`, whitespace, and camelCase).
 */
const BOT_TOOL_WORD_TABLE = {
  pay: {
    words: [
      "pay",
      "paying",
      "payment",
      "payments",
      "purchase",
      "purchasing",
      "purchases",
      "checkout",
      "buy",
      "buying",
      "subscribe",
      "subscribing",
      "subscription",
      "subscriptions",
      "tip",
      "tipping",
      "payout",
      "payouts",
      "charge",
      "charges",
    ],
    phrases: [
      ["transfer", "money"],
      ["transfer", "funds"],
      ["wire", "transfer"],
      ["bank", "transfer"],
      ["send", "money"],
      ["send", "funds"],
      ["place", "order"],
      ["create", "order"],
      ["submit", "order"],
      ["complete", "order"],
      ["confirm", "order"],
    ],
    /** Words that indicate purchasing/ordering unless paired with a read-only or sorting verb. */
    conditionalWords: ["order", "orders"],
  },
  delete: {
    words: ["delete", "remove", "trash", "purge", "drop", "destroy", "wipe", "erase"],
  },
  send: {
    verbs: ["send", "post", "reply", "forward", "publish", "share", "invite", "tweet"],
    /** Communication nouns that require approval unless paired with a read-only verb. */
    nouns: ["message", "email", "comment"],
    phrases: [
      ["create", "pr"],
      ["create", "pull", "request"],
      ["open", "pr"],
      ["open", "pull", "request"],
    ],
  },
  readOnlyVerbs: [
    "read",
    "get",
    "list",
    "search",
    "find",
    "fetch",
    "lookup",
    "view",
    "show",
    "count",
    "check",
    "describe",
    "inspect",
    "sort",
    "display",
    "rank",
  ],
} as const;

const PAY_WORDS: ReadonlySet<string> = new Set(BOT_TOOL_WORD_TABLE.pay.words);
const PAY_CONDITIONAL_WORDS: ReadonlySet<string> = new Set(
  BOT_TOOL_WORD_TABLE.pay.conditionalWords,
);
const DELETE_WORDS: ReadonlySet<string> = new Set(BOT_TOOL_WORD_TABLE.delete.words);
const SEND_VERBS: ReadonlySet<string> = new Set(BOT_TOOL_WORD_TABLE.send.verbs);
const SEND_NOUNS: ReadonlySet<string> = new Set(BOT_TOOL_WORD_TABLE.send.nouns);
const READ_ONLY_VERBS: ReadonlySet<string> = new Set(BOT_TOOL_WORD_TABLE.readOnlyVerbs);

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "terminal",
  "exec",
  "command",
  "run_command",
  "powershell",
  "pwsh",
  "cmd",
]);

const DELETE_FILE_OPERATIONS = new Set(["delete", "deleted", "remove", "removed"]);

const DELETE_BINARIES = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "remove-item",
  "ri",
  "rd",
  "unlink",
  "shred",
]);

const SEND_BINARIES = new Set(["sendmail", "mail", "mailx", "mutt"]);

const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const STRIPE_PAY_RESOURCES = new Set([
  "charges",
  "payment_intents",
  "checkout",
  "payouts",
  "transfers",
  "subscriptions",
  "invoices",
  "refunds",
]);

const STRIPE_WRITE_ACTIONS = new Set(["create", "pay", "confirm", "capture", "finalize"]);

const ALLOW: BotActionClassification = { decision: "allow" };
const ASK_SEND: BotActionClassification = { decision: "ask", category: "send" };
const ASK_DELETE: BotActionClassification = { decision: "ask", category: "delete" };
const ASK_AGENT_SETTINGS: BotActionClassification = { decision: "ask", category: "agent-settings" };
const ASK_UNKNOWN: BotActionClassification = { decision: "ask", category: "unknown" };

const HELD_CATEGORY_RANK: Record<BotHeldCategory, number> = {
  unknown: 1,
  send: 2,
  delete: 3,
  "agent-settings": 4,
};
const BLOCK_PAY: BotActionClassification = { decision: "block", category: "pay" };

function classificationRank(result: BotActionClassification): number {
  if (result.decision === "block") return 5;
  if (result.decision === "ask") return HELD_CATEGORY_RANK[result.category];
  return 0;
}

function stricterClassification(
  left: BotActionClassification,
  right: BotActionClassification,
): BotActionClassification {
  return classificationRank(right) > classificationRank(left) ? right : left;
}

/** Split an identifier or text fragment into lowercase words on delimiters and camelCase boundaries. */
export function tokenizeActionWords(input: string): ReadonlyArray<string> {
  const spaced = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function containsPhrase(words: ReadonlyArray<string>, phrase: ReadonlyArray<string>): boolean {
  if (phrase.length === 0 || words.length < phrase.length) return false;
  outer: for (let i = 0; i <= words.length - phrase.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (words[i + j] !== phrase[j]) continue outer;
    }
    return true;
  }
  return false;
}

function classifyWords(words: ReadonlyArray<string>): BotActionClassification {
  if (words.length === 0) return ALLOW;
  const wordSet = new Set(words);
  const hasReadOnlyVerb = words.some((word) => READ_ONLY_VERBS.has(word));

  for (const word of words) {
    if (PAY_WORDS.has(word)) return BLOCK_PAY;
  }
  for (const phrase of BOT_TOOL_WORD_TABLE.pay.phrases) {
    if (containsPhrase(words, phrase)) return BLOCK_PAY;
  }
  if (!hasReadOnlyVerb && words.some((word) => PAY_CONDITIONAL_WORDS.has(word))) {
    return BLOCK_PAY;
  }

  for (const word of words) {
    if (DELETE_WORDS.has(word)) return ASK_DELETE;
  }

  for (const word of words) {
    if (SEND_VERBS.has(word)) return ASK_SEND;
  }
  for (const phrase of BOT_TOOL_WORD_TABLE.send.phrases) {
    if (containsPhrase(words, phrase)) return ASK_SEND;
  }
  if (!hasReadOnlyVerb && words.some((word) => SEND_NOUNS.has(word))) {
    return ASK_SEND;
  }
  // Catch `transfer` + `money`/`funds` even when separated by one word (e.g. `transfer_usd_funds`).
  if (wordSet.has("transfer") && (wordSet.has("money") || wordSet.has("funds"))) {
    return BLOCK_PAY;
  }

  return ALLOW;
}

function splitShellSegments(command: string): ReadonlyArray<string> {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote !== "'" && ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const next = command[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      pushCurrent();
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  pushCurrent();
  return segments;
}

function tokenizeShellArgs(segment: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (quote !== "'" && ch === "\\") {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function binaryName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function unwrapCommandTokens(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    const bin = binaryName(token);
    if (
      bin === "env" ||
      bin === "sudo" ||
      bin === "command" ||
      bin === "builtin" ||
      bin === "exec"
    ) {
      index += 1;
      while (index < tokens.length && tokens[index]!.startsWith("-")) {
        const flag = tokens[index]!;
        index += 1;
        if (bin === "sudo" && (flag === "-u" || flag === "-g" || flag === "-C")) {
          index += 1;
        }
      }
      continue;
    }
    if (bin === "npx" || bin === "pnpx" || bin === "bunx" || bin === "uvx") {
      index += 1;
      while (index < tokens.length && tokens[index]!.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function isUrlPayTarget(args: ReadonlyArray<string>): boolean {
  for (const arg of args) {
    if (!/^https?:\/\//i.test(arg)) continue;
    const words = tokenizeActionWords(arg);
    if (words.some((word) => PAY_WORDS.has(word))) return true;
    for (const phrase of BOT_TOOL_WORD_TABLE.pay.phrases) {
      if (containsPhrase(words, phrase)) return true;
    }
  }
  return false;
}

function classifyGitCommand(args: ReadonlyArray<string>): BotActionClassification {
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (!token.startsWith("-")) break;
    index += 1;
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 1;
    }
  }
  const subcommand = args[index]?.toLowerCase();
  const rest = args.slice(index + 1);
  if (subcommand === "clean" || subcommand === "rm") return ASK_DELETE;
  if (subcommand === "reset" && rest.some((arg) => arg === "--hard")) return ASK_DELETE;
  if (subcommand === "branch" && rest.some((arg) => arg === "-D")) return ASK_DELETE;
  if (subcommand === "push") {
    const isForceOrDelete = rest.some(
      (arg) =>
        arg === "--force" ||
        arg === "-f" ||
        arg === "--force-with-lease" ||
        arg.startsWith("--force-with-lease=") ||
        arg === "--force-if-includes" ||
        arg === "--delete" ||
        arg === "-d",
    );
    return isForceOrDelete ? ASK_DELETE : ASK_SEND;
  }
  return ALLOW;
}

function classifyGhCommand(args: ReadonlyArray<string>): BotActionClassification {
  const group = args[0]?.toLowerCase();
  const action = args[1]?.toLowerCase();
  if (action === "delete") return ASK_DELETE;
  if (
    group === "pr" &&
    (action === "create" ||
      action === "comment" ||
      action === "review" ||
      action === "merge" ||
      action === "close")
  ) {
    return ASK_SEND;
  }
  if (group === "issue" && (action === "create" || action === "comment" || action === "close")) {
    return ASK_SEND;
  }
  if ((group === "release" || group === "gist") && action === "create") {
    return ASK_SEND;
  }
  if (group === "api") {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-X" || arg === "--method") {
        const method = args[i + 1]?.toUpperCase();
        if (method && !READ_ONLY_HTTP_METHODS.has(method)) return ASK_SEND;
      } else if (arg.startsWith("--method=")) {
        const method = arg.slice("--method=".length).toUpperCase();
        if (method && !READ_ONLY_HTTP_METHODS.has(method)) return ASK_SEND;
      } else if (
        arg === "-f" ||
        arg === "-F" ||
        arg === "--field" ||
        arg === "--raw-field" ||
        arg === "--input" ||
        arg.startsWith("--field=") ||
        arg.startsWith("--raw-field=") ||
        arg.startsWith("--input=")
      ) {
        return ASK_SEND;
      }
    }
  }
  return ALLOW;
}

function classifyCurlCommand(args: ReadonlyArray<string>): BotActionClassification {
  let mutating = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      arg === "-d" ||
      arg === "--data" ||
      arg === "--data-raw" ||
      arg === "--data-binary" ||
      arg === "--data-urlencode" ||
      arg === "--data-ascii" ||
      arg === "--json" ||
      arg === "-F" ||
      arg === "--form" ||
      arg === "--form-string" ||
      arg === "-T" ||
      arg === "--upload-file" ||
      /^-(?:d|F|T).+/.test(arg) ||
      /^--(?:data(?:-(?:raw|binary|urlencode|ascii))?|json|form(?:-string)?|upload-file)=/.test(arg)
    ) {
      mutating = true;
    } else if (arg === "-X" || arg === "--request") {
      const method = args[i + 1]?.toUpperCase();
      if (method && !READ_ONLY_HTTP_METHODS.has(method)) mutating = true;
    } else if (arg.startsWith("-X") && arg.length > 2) {
      const method = arg.slice(2).toUpperCase();
      if (!READ_ONLY_HTTP_METHODS.has(method)) mutating = true;
    } else if (arg.startsWith("--request=")) {
      const method = arg.slice("--request=".length).toUpperCase();
      if (method && !READ_ONLY_HTTP_METHODS.has(method)) mutating = true;
    }
  }
  if (!mutating) return ALLOW;
  return isUrlPayTarget(args) ? BLOCK_PAY : ASK_SEND;
}

function classifyWgetCommand(args: ReadonlyArray<string>): BotActionClassification {
  let mutating = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (
      arg === "--post-data" ||
      arg === "--post-file" ||
      arg === "--body-data" ||
      arg === "--body-file" ||
      /^--(?:post|body)-(?:data|file)=/.test(arg)
    ) {
      mutating = true;
    } else if (arg === "--method") {
      const method = args[i + 1]?.toUpperCase();
      if (method && !READ_ONLY_HTTP_METHODS.has(method)) mutating = true;
    } else if (arg.startsWith("--method=")) {
      const method = arg.slice("--method=".length).toUpperCase();
      if (method && !READ_ONLY_HTTP_METHODS.has(method)) mutating = true;
    }
  }
  if (!mutating) return ALLOW;
  return isUrlPayTarget(args) ? BLOCK_PAY : ASK_SEND;
}

function classifyPowerShellWebCommand(args: ReadonlyArray<string>): BotActionClassification {
  let mutating = false;
  for (let i = 0; i < args.length; i++) {
    const lower = args[i]!.toLowerCase();
    if (lower === "-body" || lower === "-infile") {
      mutating = true;
    } else if (lower === "-method") {
      const method = args[i + 1]?.toUpperCase();
      if (method && !READ_ONLY_HTTP_METHODS.has(method)) mutating = true;
    } else if (lower.startsWith("-method:")) {
      const method = lower.slice("-method:".length).toUpperCase();
      if (method && !READ_ONLY_HTTP_METHODS.has(method)) mutating = true;
    }
  }
  if (!mutating) return ALLOW;
  return isUrlPayTarget(args) ? BLOCK_PAY : ASK_SEND;
}

function classifyCommandSegment(segment: string, depth: number): BotActionClassification {
  const rawTokens = tokenizeShellArgs(segment);
  const tokens = unwrapCommandTokens(rawTokens);
  if (tokens.length === 0) return ALLOW;

  const bin = binaryName(tokens[0]!);
  const args = tokens.slice(1);

  // Recursively inspect nested shell invocations like `bash -c "rm -rf /tmp/x"`.
  if (depth < 3) {
    if (bin === "sh" || bin === "bash" || bin === "zsh" || bin === "dash" || bin === "fish") {
      const flagIdx = args.findIndex((arg) => arg === "-c" || arg === "-lc");
      if (flagIdx !== -1 && args[flagIdx + 1] !== undefined) {
        return classifyCommand(args[flagIdx + 1]!, depth + 1);
      }
    }
    if (bin === "pwsh" || bin === "powershell") {
      const flagIdx = args.findIndex((arg) => {
        const lower = arg.toLowerCase();
        return lower === "-c" || lower === "-command";
      });
      if (flagIdx !== -1 && args[flagIdx + 1] !== undefined) {
        return classifyCommand(args.slice(flagIdx + 1).join(" "), depth + 1);
      }
    }
    if (bin === "cmd") {
      const flagIdx = args.findIndex((arg) => arg.toLowerCase() === "/c");
      if (flagIdx !== -1 && args[flagIdx + 1] !== undefined) {
        return classifyCommand(args.slice(flagIdx + 1).join(" "), depth + 1);
      }
    }
  }

  if (bin === "stripe") {
    const resource = args[0]?.toLowerCase();
    const action = args[1]?.toLowerCase();
    if (
      resource !== undefined &&
      STRIPE_PAY_RESOURCES.has(resource) &&
      (action === undefined || STRIPE_WRITE_ACTIONS.has(action))
    ) {
      return BLOCK_PAY;
    }
  }

  if (DELETE_BINARIES.has(bin)) return ASK_DELETE;
  if (SEND_BINARIES.has(bin)) return ASK_SEND;
  if (bin === "git") return classifyGitCommand(args);
  if (bin === "gh") return classifyGhCommand(args);
  if (bin === "curl") return classifyCurlCommand(args);
  if (bin === "wget") return classifyWgetCommand(args);
  if (
    bin === "invoke-webrequest" ||
    bin === "iwr" ||
    bin === "invoke-restmethod" ||
    bin === "irm"
  ) {
    return classifyPowerShellWebCommand(args);
  }
  if (bin === "find" && args.some((arg) => arg === "-delete")) {
    return ASK_DELETE;
  }

  // Fallback for bespoke payment CLIs whose executable name explicitly names paying/purchasing.
  const binClassification = classifyWords(tokenizeActionWords(bin));
  if (binClassification.decision === "block") return binClassification;

  return ALLOW;
}

function classifyCommand(command: string, depth = 0): BotActionClassification {
  let result: BotActionClassification = ALLOW;
  for (const segment of splitShellSegments(command)) {
    result = stricterClassification(result, classifyCommandSegment(segment, depth));
    if (result.decision === "block") return result;
  }
  return result;
}

function isShellToolName(toolName: string | null | undefined): boolean {
  if (!toolName) return true;
  return SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

// Claude and Codex settings can pre-approve tools or add hooks, which would switch this gate off.
const AGENT_SETTINGS_PATH = /(?:^|[\\/\s"'=~])\.(?:claude|codex)(?:[\\/\s"'.]|$)|\.mcp\.json/i;

function touchesAgentSettings(request: BotActionRequest): boolean {
  if (request.fileChanges?.some((change) => AGENT_SETTINGS_PATH.test(change.path))) return true;
  return [request.command, request.prompt].some(
    (text) => text !== null && text !== undefined && AGENT_SETTINGS_PATH.test(text),
  );
}

function hasDeletedFileChange(request: BotActionRequest): boolean {
  if (
    request.fileChanges?.some((change) =>
      DELETE_FILE_OPERATIONS.has(change.operation.trim().toLowerCase()),
    )
  ) {
    return true;
  }
  if (request.kind === "file-change" && request.prompt) {
    return request.prompt
      .split(/\r?\n/)
      .some((line) => /^(?:delete|remove)\s+\S/i.test(line.trim()));
  }
  return false;
}

/**
 * Pure policy classifier for runtime approval requests on bot threads.
 *
 * - `block` (`pay`): paying, purchasing, checkout, ordering, transferring money, subscribing, tipping.
 * - `ask` (`send` / `delete`): outbound communication or destructive deletions.
 * - `allow`: reads, ordinary edits, and read-only tools.
 */
export function classifyBotAction(request: BotActionRequest): BotActionClassification {
  let result: BotActionClassification = ALLOW;

  if (request.toolName) {
    result = stricterClassification(result, classifyWords(tokenizeActionWords(request.toolName)));
    if (result.decision === "block") return result;
  }

  if (request.kind === "file-read") {
    return result;
  }

  if (touchesAgentSettings(request)) {
    return stricterClassification(result, ASK_AGENT_SETTINGS);
  }

  if (request.kind === "file-change") {
    if ((request.fileChanges?.length ?? 0) === 0 && !request.prompt?.trim()) {
      return stricterClassification(result, ASK_UNKNOWN);
    }
    if (hasDeletedFileChange(request)) {
      result = stricterClassification(result, ASK_DELETE);
    }
    return result;
  }

  if (request.kind === "command") {
    const commandText =
      request.command?.trim() || (isShellToolName(request.toolName) ? request.prompt?.trim() : "");
    if (commandText) {
      result = stricterClassification(result, classifyCommand(commandText));
    } else if (!request.toolName?.trim()) {
      result = stricterClassification(result, ASK_UNKNOWN);
    }
    return result;
  }

  if (
    !request.toolName?.trim() &&
    !request.command?.trim() &&
    !request.appName?.trim() &&
    !request.prompt?.trim()
  ) {
    return ASK_UNKNOWN;
  }

  // `permission` and `mcp-elicitation`: inspect command (if present), app name, and prompt text.
  if (request.command?.trim()) {
    result = stricterClassification(result, classifyCommand(request.command));
    if (result.decision === "block") return result;
  }
  if (request.appName?.trim()) {
    result = stricterClassification(result, classifyWords(tokenizeActionWords(request.appName)));
    if (result.decision === "block") return result;
  }
  if (request.prompt?.trim()) {
    result = stricterClassification(result, classifyCommand(request.prompt));
    if (result.decision === "block") return result;
    result = stricterClassification(result, classifyWords(tokenizeActionWords(request.prompt)));
  }

  return result;
}
