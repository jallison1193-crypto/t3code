import { botHeldApprovalReason, isPayUrl } from "./botActionPolicy.ts";

export interface BotPaymentDetailsInput {
  readonly command?: string | null | undefined;
  readonly prompt?: string | null | undefined;
  readonly toolName?: string | null | undefined;
  readonly toolInput?: unknown;
}

export interface BotPaymentDetails {
  readonly amount?: string | undefined;
  readonly recipient?: string | undefined;
}

const MAX_RECIPIENT_LENGTH = 60;

const CURRENCY_CODES = new Set([
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "JPY",
  "CNY",
  "HKD",
  "SGD",
  "INR",
  "KRW",
  "MXN",
  "BRL",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "CZK",
  "HUF",
  "ILS",
  "AED",
  "SAR",
  "ZAR",
  "TWD",
  "THB",
  "IDR",
  "MYR",
  "VND",
  "USDC",
  "USDT",
]);

const URL_PATTERN = /https?:\/\/[^\s"'`<>()[\]{}]+/gi;

const SYMBOL_AMOUNT_PATTERN =
  /(?<![A-Za-z0-9_])([$€£¥](?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!\.\d|,\d|[A-Za-z0-9_])/;

const AMOUNT_THEN_CODE_PATTERN =
  /(?<![A-Za-z0-9_.-])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s+([A-Za-z]{3,4})(?![A-Za-z0-9_])/g;

const CODE_THEN_AMOUNT_PATTERN =
  /(?<![A-Za-z0-9_])([A-Za-z]{3,4})\s+((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!\.\d|,\d|[A-Za-z0-9_])/g;

const STRUCTURED_AMOUNT_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[\s,{(&?])(?:--)?["']?amount["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)["']?(?=$|[\s,}&)"';\]])/gi,
  /(?:^|\s)--amount\s+["']?(\d+(?:\.\d+)?)["']?(?=$|[\s,}&)"';\]])/gi,
];

const STRUCTURED_CURRENCY_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[\s,{(&?])(?:--)?["']?currency["']?\s*[:=]\s*["']?([A-Za-z]{3,4})["']?(?=$|[\s,}&)"';\]])/gi,
  /(?:^|\s)--currency\s+["']?([A-Za-z]{3,4})["']?(?=$|[\s,}&)"';\]])/gi,
];

const RECIPIENT_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[\s,{(&?])(?:--)?["']?(?:recipient|payee|merchant|destination)["']?\s*[:=]\s*(?:"([^"\r\n]{1,120})"|'([^'\r\n]{1,120})'|([^\s,}&)"';\]\r\n]{1,120}))/gi,
  /(?:^|\s)--(?:recipient|payee|merchant|destination)\s+(?:"([^"\r\n]{1,120})"|'([^'\r\n]{1,120})'|([^\s,}&)"';\]\r\n]{1,120}))/gi,
];

const TO_OCCURRENCE_PATTERN = /(?<![A-Za-z0-9_/-])\bto\s+/gi;

const PROSE_STOP_WORDS = new Set([
  "for",
  "on",
  "at",
  "in",
  "by",
  "with",
  "from",
  "via",
  "using",
  "about",
  "because",
  "before",
  "after",
  "under",
  "over",
  "into",
  "through",
  "as",
  "of",
  "and",
  "or",
  "to",
]);

const NON_RECIPIENT_FIRST_WORDS = new Set([
  "pay",
  "paying",
  "purchase",
  "buy",
  "charge",
  "checkout",
  "order",
  "subscribe",
  "tip",
  "transfer",
  "send",
  "confirm",
  "complete",
  "submit",
  "place",
  "create",
  "make",
  "process",
  "authorize",
  "approve",
  "allow",
  "proceed",
  "continue",
  "finish",
  "start",
  "run",
  "execute",
  "open",
  "view",
  "check",
  "verify",
  "test",
  "try",
  "get",
  "set",
  "add",
  "update",
  "upgrade",
  "downgrade",
  "cancel",
  "refund",
  "renew",
  "enable",
  "disable",
  "switch",
  "move",
  "go",
  "return",
  "connect",
  "sign",
  "log",
  "use",
  "avoid",
  "prevent",
  "keep",
  "help",
  "be",
  "have",
  "do",
  "see",
  "read",
  "write",
  "delete",
  "remove",
  "post",
  "call",
  "fetch",
  "finalize",
  "capture",
  "settle",
  "issue",
  "bill",
  "collect",
  "withdraw",
  "deposit",
  "spend",
  "donate",
  "fund",
  "reimburse",
  "trigger",
  "invoke",
  "access",
  "perform",
  "handle",
  "save",
  "store",
  "export",
  "import",
  "sync",
  "link",
  "unlock",
  "activate",
  "claim",
  "redeem",
  "book",
  "reserve",
  "hire",
  "rent",
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "our",
  "their",
  "its",
  "it",
  "them",
  "him",
  "her",
  "us",
  "me",
  "you",
  "cart",
  "billing",
  "payment",
  "payments",
  "invoice",
  "subscription",
  "plan",
  "account",
  "card",
  "wallet",
  "bank",
  "balance",
  "total",
  "amount",
  "price",
  "cost",
]);

const IGNORED_RECIPIENT_LITERALS = new Set(["null", "true", "false", "undefined", "none", "n/a"]);

function stringifyToolInput(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" && serialized !== "[]" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function stripUrls(text: string): string {
  return text.replace(URL_PATTERN, " ");
}

function sanitizeRecipient(raw: string): string | undefined {
  let cleaned = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^https?:\/\//i.test(cleaned)) {
    const host = parseUrlHost(cleaned);
    if (host === undefined) return undefined;
    cleaned = host;
  }
  cleaned = cleaned
    .replace(/^[("'[{]+/, "")
    .replace(/[.,;:!?)"'\]}]+$/, "")
    .trim();
  if (cleaned.length === 0) return undefined;
  if (IGNORED_RECIPIENT_LITERALS.has(cleaned.toLowerCase())) return undefined;
  if (/^[^A-Za-z0-9@]+$/.test(cleaned)) return undefined;
  if (cleaned.length > MAX_RECIPIENT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_RECIPIENT_LENGTH).trim();
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseUrlHost(rawUrl: string): string | undefined {
  const cleaned = rawUrl.replace(/['"),.;!?\]}>]+$/, "");
  try {
    const parsed = new URL(cleaned);
    const host = parsed.hostname.trim().toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

function extractExplicitAmount(text: string): string | undefined {
  const withoutUrls = stripUrls(text);

  const symbolMatch = SYMBOL_AMOUNT_PATTERN.exec(withoutUrls);
  if (symbolMatch?.[1] !== undefined) {
    return symbolMatch[1];
  }

  for (const match of withoutUrls.matchAll(AMOUNT_THEN_CODE_PATTERN)) {
    const value = match[1];
    const code = match[2]?.toUpperCase();
    if (value !== undefined && code !== undefined && CURRENCY_CODES.has(code)) {
      return `${value} ${code}`;
    }
  }

  for (const match of withoutUrls.matchAll(CODE_THEN_AMOUNT_PATTERN)) {
    const code = match[1]?.toUpperCase();
    const value = match[2];
    if (code !== undefined && value !== undefined && CURRENCY_CODES.has(code)) {
      return `${code} ${value}`;
    }
  }

  return undefined;
}

function extractStructuredAmount(texts: ReadonlyArray<string>): string | undefined {
  const amounts = new Set<string>();
  const currencies = new Set<string>();

  for (const text of texts) {
    for (const pattern of STRUCTURED_AMOUNT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[1];
        if (raw === undefined) continue;
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
          amounts.add(raw);
        }
      }
    }
    for (const pattern of STRUCTURED_CURRENCY_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[1];
        if (raw === undefined) continue;
        const upper = raw.toUpperCase();
        if (CURRENCY_CODES.has(upper)) {
          currencies.add(upper.toLowerCase());
        }
      }
    }
  }

  if (amounts.size !== 1 || currencies.size !== 1) return undefined;
  const amount = [...amounts][0]!;
  const currency = [...currencies][0]!;
  return `amount ${amount} (${currency})`;
}

function extractKeyedRecipient(text: string): string | undefined {
  for (const pattern of RECIPIENT_KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (raw === undefined) continue;
      const cleaned = sanitizeRecipient(raw);
      if (cleaned !== undefined) return cleaned;
    }
  }
  return undefined;
}

function extractProseRecipient(text: string): string | undefined {
  const withoutUrls = stripUrls(text);

  for (const match of withoutUrls.matchAll(TO_OCCURRENCE_PATTERN)) {
    const start = (match.index ?? 0) + match[0].length;
    const rest = withoutUrls.slice(start);
    if (rest.length === 0) continue;

    const quoted = /^["']([^"'\r\n]{1,80})["']/.exec(rest);
    if (quoted?.[1] !== undefined) {
      const cleaned = sanitizeRecipient(quoted[1]);
      if (cleaned !== undefined) return cleaned;
      continue;
    }

    const handleOrEmail =
      /^(@[A-Za-z0-9._-]{1,60}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(rest);
    if (handleOrEmail?.[1] !== undefined) {
      const cleaned = sanitizeRecipient(handleOrEmail[1]);
      if (cleaned !== undefined) return cleaned;
      continue;
    }

    // Stop at punctuation, newlines, CLI flags, or another sentence.
    const segment = rest.split(/[,;?!()[\]{}\r\n]|(?:\s+--?)|(?:\.(?:\s|$))/)[0]?.trim() ?? "";
    if (segment.length === 0) continue;

    const rawWords = segment.split(/\s+/);
    const firstWord = rawWords[0]?.replace(/[^A-Za-z0-9@._-]/g, "") ?? "";
    const firstLower = firstWord.toLowerCase();
    if (
      firstWord.length === 0 ||
      /^\d/.test(firstWord) ||
      /^[$€£¥]/.test(rawWords[0] ?? "") ||
      CURRENCY_CODES.has(firstWord.toUpperCase()) ||
      NON_RECIPIENT_FIRST_WORDS.has(firstLower)
    ) {
      continue;
    }

    const kept: string[] = [];
    for (const word of rawWords) {
      if (kept.length >= 4) break;
      const bare = word.replace(/^["'(]+|[.,;:!?"')]+$/g, "");
      if (bare.length === 0) break;
      if (kept.length > 0 && PROSE_STOP_WORDS.has(bare.toLowerCase())) break;
      if (/^[$€£¥]\d/.test(bare)) break;
      kept.push(word);
    }

    const cleaned = sanitizeRecipient(kept.join(" "));
    if (cleaned !== undefined) return cleaned;
  }

  return undefined;
}

function extractPayUrlHost(text: string): string | undefined {
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(/['"),.;!?\]}>]+$/, "");
    if (!isPayUrl(candidate)) continue;
    const host = parseUrlHost(candidate);
    if (host !== undefined) return host;
  }
  return undefined;
}

/**
 * Best-effort extraction of payment amount and recipient from an action's command,
 * prompt, tool input, and tool name. Deterministic for the same input.
 */
export function extractBotPaymentDetails(input: BotPaymentDetailsInput): BotPaymentDetails {
  const texts = [
    input.command,
    input.prompt,
    stringifyToolInput(input.toolInput),
    input.toolName,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  if (texts.length === 0) return {};

  let amount: string | undefined;
  for (const text of texts) {
    amount = extractExplicitAmount(text);
    if (amount !== undefined) break;
  }
  amount ??= extractStructuredAmount(texts);

  let recipient: string | undefined;
  for (const text of texts) {
    recipient = extractKeyedRecipient(text);
    if (recipient !== undefined) break;
  }
  if (recipient === undefined) {
    // Only scan command and prompt for prose `to <name>` (not JSON toolInput or identifier toolName).
    for (const text of [input.command, input.prompt]) {
      if (typeof text !== "string" || text.trim().length === 0) continue;
      recipient = extractProseRecipient(text);
      if (recipient !== undefined) break;
    }
  }
  if (recipient === undefined) {
    for (const text of texts) {
      recipient = extractPayUrlHost(text);
      if (recipient !== undefined) break;
    }
  }

  return {
    ...(amount === undefined ? {} : { amount }),
    ...(recipient === undefined ? {} : { recipient }),
  };
}

export function formatBotPaymentHeldReason(input: BotPaymentDetailsInput): string {
  const base = botHeldApprovalReason("pay");
  const details = extractBotPaymentDetails(input);
  if (details.amount !== undefined && details.recipient !== undefined) {
    return `${base}: ${details.amount} to ${details.recipient}`;
  }
  if (details.amount !== undefined) {
    return `${base}: ${details.amount}`;
  }
  if (details.recipient !== undefined) {
    return `${base}: to ${details.recipient}`;
  }
  return base;
}
