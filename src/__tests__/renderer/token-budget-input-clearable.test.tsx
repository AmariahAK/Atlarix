import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TokenBudgetInput } from "@/components/settings/TokenBudgetInput";

/**
 * The token budget cap must be CLEARABLE.
 *
 * THE BUG THIS PINS. `localValue` used `""` for two different states — "the
 * user has not typed anything, so show the saved value" and "the user emptied
 * the field". So deleting the last digit set `localValue` to `""`, the display
 * logic read that as "not editing", and the saved number snapped straight back
 * into the box. The field could not be cleared at all.
 *
 * The only way through was to type a second digit and then delete the first,
 * which left a literal `0` on screen — and `0` failed the `> 0` check on blur,
 * so the override was silently deleted while the input still showed `0`. The
 * number on screen was not the setting in force, which is why the report was
 * "I can't tell when it's 0 (back to auto)".
 *
 * Two states sharing one spelling. The tests below are the two states.
 */

const updateSettings = vi.fn();
let currentOverrides: Record<string, number> = {};

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { tokenBudgetOverrides: currentOverrides },
    updateSettings,
  }),
}));

beforeEach(() => {
  updateSettings.mockReset();
  updateSettings.mockResolvedValue(undefined);
  currentOverrides = {};
});

function input() {
  return screen.getByPlaceholderText(
    "Auto · model context",
  ) as HTMLInputElement;
}

describe("token budget cap — clearing it", () => {
  it("stays empty when cleared, instead of snapping back to the saved value", () => {
    currentOverrides = { openai: 50_000 };
    render(<TokenBudgetInput providerId="openai" />);
    expect(input().value).toBe("50000");

    fireEvent.change(input(), { target: { value: "" } });

    // The whole bug: this used to read "50000" again the moment the field
    // emptied, because "" meant "not editing".
    expect(input().value).toBe("");
  });

  it("clearing the field removes the override rather than saving a zero", async () => {
    currentOverrides = { openai: 50_000 };
    render(<TokenBudgetInput providerId="openai" />);

    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.blur(input());

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ tokenBudgetOverrides: {} });
  });

  it("says which state it is in, so an empty box is not ambiguous", () => {
    render(<TokenBudgetInput providerId="openai" />);
    expect(
      screen.getByText(/No cap — using the model's full context window/),
    ).toBeTruthy();

    currentOverrides = { openai: 50_000 };
    render(<TokenBudgetInput providerId="anthropic" />);
    // Same store, different provider id: anthropic has no cap of its own.
    expect(
      screen.getAllByText(/No cap — using the model's full context window/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("offers a one-click way back to auto when a cap is set", async () => {
    currentOverrides = { openai: 50_000 };
    render(<TokenBudgetInput providerId="openai" />);

    fireEvent.click(screen.getByRole("button", { name: "Use auto" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ tokenBudgetOverrides: {} });
  });

  it("shows no 'Use auto' button when there is nothing to clear", () => {
    render(<TokenBudgetInput providerId="openai" />);
    expect(screen.queryByRole("button", { name: "Use auto" })).toBeNull();
  });

  it("a typed 0 clears the cap and does not persist as a zero budget", async () => {
    currentOverrides = { openai: 50_000 };
    render(<TokenBudgetInput providerId="openai" />);

    fireEvent.change(input(), { target: { value: "0" } });
    fireEvent.blur(input());

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ tokenBudgetOverrides: {} });
  });

  it("clamps a below-minimum entry up instead of silently discarding it", async () => {
    render(<TokenBudgetInput providerId="openai" />);

    fireEvent.change(input(), { target: { value: "500" } });
    fireEvent.blur(input());

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    // 500 means "a small cap", not "no cap" — dropping it to auto would be the
    // worse surprise, so it is raised to the floor and the user is told.
    expect(updateSettings).toHaveBeenCalledWith({
      tokenBudgetOverrides: { openai: 1000 },
    });
  });

  it("Escape abandons a draft and restores the saved value", () => {
    currentOverrides = { openai: 50_000 };
    render(<TokenBudgetInput providerId="openai" />);

    fireEvent.change(input(), { target: { value: "123" } });
    expect(input().value).toBe("123");

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().value).toBe("50000");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("saves a valid cap", async () => {
    render(<TokenBudgetInput providerId="openai" />);

    fireEvent.change(input(), { target: { value: "64000" } });
    fireEvent.blur(input());

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      tokenBudgetOverrides: { openai: 64000 },
    });
  });
});
