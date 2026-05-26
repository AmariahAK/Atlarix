import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultStore } from "jotai";
import {
  chatBoundAppIdByChatIdAtom,
  pendingWorkspaceAppIdAtom,
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import {
  attachWorkspaceToChat,
  bindChatToAppId,
  resolveChatWorkspaceAppId,
} from "@/lib/chat-workspace-binding";

function resetWorkspaceAtoms(): void {
  const store = getDefaultStore();
  store.set(chatBoundAppIdByChatIdAtom, new Map());
  store.set(selectedAppIdAtom, null);
  store.set(pendingWorkspaceAppIdAtom, null);
  store.set(selectedWorkspaceInfoAtom, null);
}

describe("resolveChatWorkspaceAppId", () => {
  beforeEach(() => {
    resetWorkspaceAtoms();
  });

  it("returns null when chat is unbound and no workspace is selected", () => {
    expect(resolveChatWorkspaceAppId(-1)).toBeNull();
    expect(resolveChatWorkspaceAppId(null)).toBeNull();
  });

  it("falls back to selectedAppId when chat is not bound", () => {
    getDefaultStore().set(selectedAppIdAtom, 42);
    expect(resolveChatWorkspaceAppId(-99)).toBe(42);
  });

  it("prefers bound app id over global selectedAppId", () => {
    getDefaultStore().set(selectedAppIdAtom, 10);
    bindChatToAppId(-5, 20);
    expect(resolveChatWorkspaceAppId(-5)).toBe(20);
  });

  it("returns null when chat is explicitly bound without workspace", () => {
    bindChatToAppId(-3, undefined);
    getDefaultStore().set(selectedAppIdAtom, 99);
    expect(resolveChatWorkspaceAppId(-3)).toBeNull();
  });
});

describe("attachWorkspaceToChat", () => {
  beforeEach(() => {
    resetWorkspaceAtoms();
  });

  it("binds chat, sets selection, workspace info, and clears pending", () => {
    getDefaultStore().set(pendingWorkspaceAppIdAtom, 7);
    attachWorkspaceToChat(-12, 5, { name: "MyRepo", path: "/tmp/repo" });

    const store = getDefaultStore();
    expect(store.get(chatBoundAppIdByChatIdAtom).get(-12)).toBe(5);
    expect(store.get(selectedAppIdAtom)).toBe(5);
    expect(store.get(pendingWorkspaceAppIdAtom)).toBeNull();
    expect(store.get(selectedWorkspaceInfoAtom)).toEqual({
      id: 5,
      name: "MyRepo",
      path: "/tmp/repo",
    });
    expect(resolveChatWorkspaceAppId(-12)).toBe(5);
  });
});
