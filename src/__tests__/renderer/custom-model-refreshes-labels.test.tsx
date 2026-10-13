/**
 * QA (app) #41: a model added by hand as "QA Mini" (id gpt-4o-mini) showed in
 * the composer as "GPT 4o Mini" — its id, formatted. Adding it refreshed the
 * provider page's own list, not the shared one the composer's label reads.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const createCustomLanguageModel = vi.fn(async () => ({}));
const fakeIpc = Object.assign(makeFakeIpc(), { createCustomLanguageModel });
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
vi.mock("@/lib/toast", () => ({ showSuccess: vi.fn(), showError: vi.fn() }));

import { CreateCustomModelDialog } from "@/components/CreateCustomModelDialog";

describe("adding a model by hand", () => {
  it("refreshes the list the composer's label reads", async () => {
    const { queryClient } = renderWithProviders(
      <CreateCustomModelDialog isOpen onClose={() => {}} onSuccess={() => {}} providerId="custom::qa" />,
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const id = document.getElementById("model-id") as HTMLInputElement;
    const name = document.getElementById("model-name") as HTMLInputElement;
    fireEvent.change(id, { target: { value: "gpt-4o-mini" } });
    fireEvent.change(name, { target: { value: "QA Mini" } });
    await act(async () => fireEvent.submit(id.closest("form")!));
    await waitFor(() => expect(createCustomLanguageModel).toHaveBeenCalled());
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["language-models-by-providers"] })),
    );
  });
});
