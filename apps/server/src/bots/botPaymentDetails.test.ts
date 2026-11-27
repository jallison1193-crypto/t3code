import { describe, expect, it } from "@effect/vitest";

import {
  type BotPaymentDetails,
  type BotPaymentDetailsInput,
  extractBotPaymentDetails,
  formatBotPaymentHeldReason,
} from "./botPaymentDetails.ts";

describe("botPaymentDetails", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: BotPaymentDetailsInput;
    readonly expectedDetails: BotPaymentDetails;
    readonly expectedReason: string;
  }> = [
    {
      name: "extracts dollar amount and prose recipient",
      input: { prompt: "Pay $25.00 to Acme" },
      expectedDetails: { amount: "$25.00", recipient: "Acme" },
      expectedReason: "Bots ask before paying: $25.00 to Acme",
    },
    {
      name: "extracts whole dollar amount without decimals",
      input: { prompt: "Tip $25 to @creator" },
      expectedDetails: { amount: "$25", recipient: "@creator" },
      expectedReason: "Bots ask before paying: $25 to @creator",
    },
    {
      name: "extracts comma-grouped dollar amount and stops recipient before preposition",
      input: { prompt: "Send $1,299.99 to Acme Corp for annual license" },
      expectedDetails: { amount: "$1,299.99", recipient: "Acme Corp" },
      expectedReason: "Bots ask before paying: $1,299.99 to Acme Corp",
    },
    {
      name: "extracts amount followed by currency code",
      input: { prompt: "Transfer 25 USD to Alice Smith" },
      expectedDetails: { amount: "25 USD", recipient: "Alice Smith" },
      expectedReason: "Bots ask before paying: 25 USD to Alice Smith",
    },
    {
      name: "extracts currency code followed by amount and email recipient",
      input: { prompt: "Wire EUR 10 to billing@example.eu" },
      expectedDetails: { amount: "EUR 10", recipient: "billing@example.eu" },
      expectedReason: "Bots ask before paying: EUR 10 to billing@example.eu",
    },
    {
      name: "extracts JSON amount with currency without guessing cents vs units",
      input: {
        command:
          'curl -X POST -d \'{"amount": 2500, "currency": "usd", "merchant": "Acme"}\' https://api.stripe.com/v1/charges',
      },
      expectedDetails: { amount: "amount 2500 (usd)", recipient: "Acme" },
      expectedReason: "Bots ask before paying: amount 2500 (usd) to Acme",
    },
    {
      name: "extracts CLI flag amount and currency",
      input: {
        command: "stripe charges create --amount=2500 --currency=USD",
      },
      expectedDetails: { amount: "amount 2500 (usd)" },
      expectedReason: "Bots ask before paying: amount 2500 (usd)",
    },
    {
      name: "extracts structured amount and payee from toolInput object",
      input: {
        toolName: "mcp__stripe__stripe_checkout",
        toolInput: { amount: 2500, currency: "eur", payee: "Acme EU" },
      },
      expectedDetails: { amount: "amount 2500 (eur)", recipient: "Acme EU" },
      expectedReason: "Bots ask before paying: amount 2500 (eur) to Acme EU",
    },
    {
      name: "extracts destination key from nested toolInput",
      input: {
        toolName: "stripe__transfer_funds",
        toolInput: { args: { amount: 5000, currency: "usd", destination: "acct_1234" } },
      },
      expectedDetails: { amount: "amount 5000 (usd)", recipient: "acct_1234" },
      expectedReason: "Bots ask before paying: amount 5000 (usd) to acct_1234",
    },
    {
      name: "extracts recipient key over pay URL host",
      input: {
        command:
          'curl -X POST https://checkout.stripe.com/v1/pay -d \'{"recipient": "Coffee Shop"}\'',
      },
      expectedDetails: { recipient: "Coffee Shop" },
      expectedReason: "Bots ask before paying: to Coffee Shop",
    },
    {
      name: "falls back to the host of a pay URL when no explicit recipient is present",
      input: {
        command: 'curl -X POST -d \'{"plan":"pro"}\' https://checkout.acme.com/v1/checkout',
      },
      expectedDetails: { recipient: "checkout.acme.com" },
      expectedReason: "Bots ask before paying: to checkout.acme.com",
    },
    {
      name: "skips infinitive verb after to and finds later recipient",
      input: { prompt: "Allow bot to send $42.50 to Acme Labs?" },
      expectedDetails: { amount: "$42.50", recipient: "Acme Labs" },
      expectedReason: "Bots ask before paying: $42.50 to Acme Labs",
    },
    {
      name: "shows only amount when prompt has infinitive verb after to",
      input: { prompt: "Allow Stripe to charge $15.00?" },
      expectedDetails: { amount: "$15.00" },
      expectedReason: "Bots ask before paying: $15.00",
    },
    {
      name: "omits JSON amount when currency is missing",
      input: {
        toolName: "mcp__stripe__stripe_checkout",
        toolInput: { amount: 2500 },
      },
      expectedDetails: {},
      expectedReason: "Bots ask before paying",
    },
    {
      name: "omits JSON amount when multiple conflicting amounts appear",
      input: {
        prompt:
          'Compare {"amount": 1000, "currency": "usd"} and {"amount": 2000, "currency": "usd"}',
      },
      expectedDetails: {},
      expectedReason: "Bots ask before paying",
    },
    {
      name: "deduplicates identical repeated command and prompt structured amount",
      input: {
        command: "stripe charges create --amount=2500 --currency=usd",
        prompt: "stripe charges create --amount=2500 --currency=usd",
      },
      expectedDetails: { amount: "amount 2500 (usd)" },
      expectedReason: "Bots ask before paying: amount 2500 (usd)",
    },
    {
      name: "ignores misleading infinitive phrasing with no amount",
      input: { prompt: "Allow stripe_checkout to purchase item?" },
      expectedDetails: {},
      expectedReason: "Bots ask before paying",
    },
    {
      name: "ignores misleading non-currency words, paths, versions, and prose merchant word",
      input: {
        command:
          'pay_cli --note "The merchant asked to checkout PHP 8 /path/to/receipt.txt $1.2.3 $abc 10 TRY 5 FOR"',
      },
      expectedDetails: {},
      expectedReason: "Bots ask before paying",
    },
    {
      name: "ignores non-pay URLs and partial amount key names",
      input: {
        command:
          'curl -X POST https://docs.example.com/help -d \'{"min_amount": 100, "currency": "usd"}\'',
      },
      expectedDetails: {},
      expectedReason: "Bots ask before paying",
    },
    {
      name: "returns base reason when input has no details",
      input: { toolName: "pay_invoice" },
      expectedDetails: {},
      expectedReason: "Bots ask before paying",
    },
  ];

  it.each(cases)("$name", ({ input, expectedDetails, expectedReason }) => {
    expect(extractBotPaymentDetails(input)).toEqual(expectedDetails);
    expect(formatBotPaymentHeldReason(input)).toBe(expectedReason);
    // Deterministic for the same input.
    expect(formatBotPaymentHeldReason(input)).toBe(expectedReason);
  });
});
