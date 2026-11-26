import type { BotLimitMode } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { formatBotTokenCount, parseBotPositiveInt } from "./bots.logic";

export function BotLimitModeSelect({
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  readonly value: BotLimitMode;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly onChange: (next: BotLimitMode) => void;
}) {
  const gt = useGT();
  const limitModeLabels: Record<BotLimitMode, string> = {
    runs_and_tokens: gt("Runs and tokens"),
    runs_only: gt("Runs only"),
    none: gt("No limits"),
  };

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "runs_and_tokens" || next === "runs_only" || next === "none") {
          onChange(next);
        }
      }}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue>{limitModeLabels[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="runs_and_tokens">{limitModeLabels.runs_and_tokens}</SelectItem>
        <SelectItem value="runs_only">{limitModeLabels.runs_only}</SelectItem>
        <SelectItem value="none">{limitModeLabels.none}</SelectItem>
      </SelectPopup>
    </Select>
  );
}

export function BotLimitNumberInputs({
  idPrefix,
  mode,
  disabled,
  runsText,
  tokensText,
  onRunsChange,
  onTokensChange,
  onCommit,
}: {
  readonly idPrefix: string;
  readonly mode: BotLimitMode;
  readonly disabled: boolean;
  readonly runsText: string;
  readonly tokensText: string;
  readonly onRunsChange: (value: string) => void;
  readonly onTokensChange: (value: string) => void;
  readonly onCommit?: () => void;
}) {
  if (mode === "none") return null;

  const parsedRuns = parseBotPositiveInt(runsText);
  const parsedTokens = parseBotPositiveInt(tokensText);
  const runsId = `${idPrefix}-runs-limit`;
  const tokensId = `${idPrefix}-tokens-limit`;
  const tokensHintId = `${idPrefix}-tokens-hint`;

  return (
    <div className="grid gap-3 pt-3 pb-2 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={runsId}>
          <T>Runs per day</T>
        </Label>
        <Input
          id={runsId}
          type="number"
          min={1}
          step={1}
          disabled={disabled}
          aria-invalid={parsedRuns === null}
          value={runsText}
          onChange={(event) => onRunsChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onCommit) {
              event.currentTarget.blur();
            }
          }}
        />
      </div>
      {mode === "runs_and_tokens" ? (
        <div className="space-y-1">
          <Label htmlFor={tokensId}>
            <T>Tokens per day</T>
          </Label>
          <Input
            id={tokensId}
            type="number"
            min={1}
            step={100000}
            disabled={disabled}
            aria-invalid={parsedTokens === null}
            aria-describedby={tokensHintId}
            value={tokensText}
            onChange={(event) => onTokensChange(event.target.value)}
            onBlur={onCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && onCommit) {
                event.currentTarget.blur();
              }
            }}
          />
          <p id={tokensHintId} className="text-xs text-muted-foreground">
            {parsedTokens === null ? null : formatBotTokenCount(parsedTokens)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
