/**
 * Dictation used to look stuck: a spinner inside the mic button was the only
 * sign a clip was transcribing. The strip above the composer shows the wait,
 * and streamed words replace it as soon as they arrive.
 */
import React from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceDictationByChatAtom } from "@/atoms/chatAtoms";
import {
  VoiceDictationStatus,
  formatClipDuration,
  type VoiceDictationState,
} from "@/components/chat/VoiceDictationStatus";

// ── IPC fake for the hook test ──
let partialListener: ((p: { requestId?: string; text: string }) => void) | null =
  null;
let lastRequestId: string | undefined;
let finishTranscription: (text: string) => void = () => {};
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      onVoiceTranscriptPartial: (
        l: (p: { requestId?: string; text: string }) => void,
      ) => {
        partialListener = l;
        return () => {
          partialListener = null;
        };
      },
      transcribeAudioWithModel: (p: { requestId?: string }) => {
        lastRequestId = p.requestId;
        return new Promise<string>((r) => {
          finishTranscription = r;
        });
      },
      transcribeAudioCloud: vi.fn(),
    }),
  },
}));

import { downsampleLevels, useVoiceInput } from "@/hooks/useVoiceInput";

function state(over: Partial<VoiceDictationState> = {}): VoiceDictationState {
  return {
    isRecording: false,
    isTranscribing: true,
    hasPartial: false,
    levels: [],
    waveform: new Array(32).fill(0.5),
    recordedMs: 7_000,
    recordingStartedAt: 0,
    cancel: vi.fn(),
    ...over,
  };
}

function renderStrip(s: VoiceDictationState | undefined) {
  const store = createStore();
  if (s) store.set(voiceDictationByChatAtom, new Map([[1, s]]));
  return render(
    <Provider store={store}>
      <VoiceDictationStatus chatId={1} />
    </Provider>,
  );
}

describe("VoiceDictationStatus", () => {
  it("shows the clip length and a cancel while transcribing", () => {
    const s = state();
    renderStrip(s);
    expect(screen.getByText(/Transcribing 0:07 of audio/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(s.cancel).toHaveBeenCalledOnce();
  });

  it("gets out of the way once streamed words arrive", () => {
    renderStrip(state({ hasPartial: true }));
    expect(screen.queryByTestId("voice-dictation-status")).toBeNull();
  });

  it("shows Listening while recording", () => {
    renderStrip(
      state({ isRecording: true, isTranscribing: false, recordingStartedAt: Date.now() }),
    );
    expect(screen.getByText(/Listening 0:0/)).toBeTruthy();
  });

  it("renders nothing when idle", () => {
    renderStrip(undefined);
    expect(screen.queryByTestId("voice-dictation-status")).toBeNull();
  });

  it("formats durations and keeps waveform peaks", () => {
    expect(formatClipDuration(65_400)).toBe("1:05");
    expect(downsampleLevels([0, 0.9, 0, 0, 0.2, 0], 3)).toEqual([0.9, 0, 0.2]);
    expect(downsampleLevels([], 4)).toEqual([0, 0, 0, 0]);
  });
});

// ── hook: preview → final, and cancel restores ──
class FakeRecorder {
  static isTypeSupported = () => true;
  mimeType = "audio/ogg";
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["x"], { type: "audio/ogg" }) });
    this.onstop?.();
  }
}

describe("useVoiceInput model route streaming", () => {
  beforeEach(() => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function recordAndStop(onTranscript: (t: string, f: boolean) => void) {
    const hook = renderHook(() =>
      useVoiceInput({ route: { kind: "model" }, onTranscript } as never),
    );
    await act(async () => hook.result.current.start());
    await act(async () => {
      hook.result.current.stop();
      await new Promise((r) => setTimeout(r, 0));
    });
    return hook;
  }

  it("inserts streamed previews, then commits the final text", async () => {
    const calls: Array<[string, boolean]> = [];
    const hook = await recordAndStop((t, f) => calls.push([t, f]));
    expect(hook.result.current.isTranscribing).toBe(true);

    act(() => partialListener?.({ requestId: "someone-else", text: "no" }));
    act(() => partialListener?.({ requestId: lastRequestId, text: "Hello" }));
    expect(hook.result.current.hasPartial).toBe(true);
    await act(async () => finishTranscription("Hello world"));

    expect(calls).toEqual([
      ["Hello", false],
      ["Hello world", true],
    ]);
  });

  it("cancel takes a half-streamed preview back out", async () => {
    const calls: Array<[string, boolean]> = [];
    const hook = await recordAndStop((t, f) => calls.push([t, f]));
    act(() => partialListener?.({ requestId: lastRequestId, text: "Hel" }));
    act(() => hook.result.current.cancel());
    await act(async () => finishTranscription("Hello"));
    expect(calls).toEqual([
      ["Hel", false],
      ["", true],
    ]);
  });
});
