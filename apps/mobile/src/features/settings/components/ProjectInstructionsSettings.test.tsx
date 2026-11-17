import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  defaultValue: string;
  placeholder?: string;
  editable?: boolean;
  onChangeText: (text: string) => void;
  onEndEditing: () => void;
};

type ButtonProps = {
  label: string;
  disabled?: boolean;
  onPress: () => void;
};

const inputs = vi.hoisted(() => new Map<string, InputProps>());
const buttons = vi.hoisted(() => new Map<string, ButtonProps>());

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("gt-react-native", () => ({
  useGT: () => (text: string) => text,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({
    title,
    trailing,
    footer,
    children,
  }: {
    title?: string;
    trailing?: ReactNode;
    footer?: string;
    children: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      {trailing}
      {children}
      {footer ? <span>{footer}</span> : null}
    </div>
  ),
}));

import {
  ProjectInstructionsSettings,
  type ProjectInstructionsSource,
} from "./ProjectInstructionsSettings";

const LABEL = "Project instructions";

let root: Root;
let container: HTMLDivElement;
const onSave = vi.fn();
const onClear = vi.fn();

function render(
  props: {
    instructions?: string | null;
    source?: ProjectInstructionsSource;
    disabled?: boolean;
    pending?: boolean;
  } = {},
) {
  act(() =>
    root.render(
      <ProjectInstructionsSettings
        instructions={props.instructions !== undefined ? props.instructions : ""}
        source={props.source ?? "environment"}
        disabled={props.disabled ?? false}
        pending={props.pending ?? false}
        onSave={onSave}
        onClear={onClear}
      />,
    ),
  );
}

function leaveScreen() {
  act(() => root.unmount());
  container = document.createElement("div");
  root = createRoot(container);
}

function input() {
  const props = inputs.get(LABEL);
  if (!props) throw new Error(`${LABEL} input not rendered`);
  return props;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  inputs.clear();
  buttons.clear();
  onSave.mockClear();
  onClear.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ProjectInstructionsSettings", () => {
  it("renders the helper text and saves trimmed instructions on end editing", () => {
    render({ instructions: "", source: "environment" });
    expect(container.textContent).toContain(
      "Shared with every thread in this project, whatever the provider.",
    );

    act(() => input().onChangeText("  Keep functions pure.  "));
    act(() => input().onEndEditing());

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Keep functions pure.");
    expect(onClear).not.toHaveBeenCalled();
  });

  it("saves unsent instructions when the screen unmounts before editing ends", () => {
    render({ instructions: "", source: "environment" });
    act(() => input().onChangeText("  Use Bun for scripts.  "));
    leaveScreen();

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Use Bun for scripts.");
    expect(onClear).not.toHaveBeenCalled();
  });

  it("clears the override when emptied while overridden", () => {
    render({ instructions: "Old instructions", source: "project" });
    act(() => input().onChangeText("   "));
    act(() => input().onEndEditing());

    expect(onClear).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not emit save or clear when empty and inherited", () => {
    render({ instructions: "", source: "environment" });
    act(() => input().onChangeText("   "));
    act(() => input().onEndEditing());

    expect(onSave).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("drops a stale draft when a newer saved value replaces the field", () => {
    render({ instructions: "First", source: "project" });
    act(() => input().onChangeText("Stale edit"));
    render({ instructions: "Updated from another client", source: "project" });
    leaveScreen();

    expect(onSave).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("resets an overridden value via Use default without re-saving a discarded draft", () => {
    render({ instructions: "Overridden", source: "project" });
    act(() => input().onChangeText("Half-typed replacement"));
    const reset = buttons.get("Use default");
    expect(reset).toBeDefined();
    act(() => reset!.onPress());
    leaveScreen();

    expect(onClear).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});
