/**
 * Attachment overflow folding: when more than 3 FOLDABLE attachments are
 * present they collapse into one summary chip whose popover lists each with its
 * own chip; background-job attachments are never folded and never counted.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { AttachmentsList } from "@/components/chat/AttachmentsList";
import { backgroundJobDisplayName } from "@/lib/chat/background-job-attachment";
import type { FileAttachment } from "@/ipc/ipc_types";

function textPaste(n: number): FileAttachment {
  return {
    type: "chat-context",
    textPaste: { content: `content ${n}`, displayName: `Pasted ${n}` },
  } as FileAttachment;
}

function bgJob(id: string): FileAttachment {
  return {
    type: "chat-context",
    backgroundJob: { jobId: id, command: `cmd ${id}`, outputTail: "out" },
  } as FileAttachment;
}

describe("AttachmentsList folding", () => {
  it("renders chips inline when foldable count <= 3", () => {
    renderWithProviders(
      <AttachmentsList
        attachments={[textPaste(1), textPaste(2), textPaste(3)]}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByText("Attachments")).toBeNull();
    expect(screen.getByText("Pasted 1")).toBeInTheDocument();
    expect(screen.getByText("Pasted 3")).toBeInTheDocument();
  });

  it("folds into a summary chip when foldable count > 3", () => {
    renderWithProviders(
      <AttachmentsList
        attachments={[textPaste(1), textPaste(2), textPaste(3), textPaste(4)]}
        onRemove={() => {}}
      />,
    );
    // Summary chip shows the count + label; individual chips are not inline yet.
    expect(screen.getByText("Attachments")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.queryByText("Pasted 1")).toBeNull();

    // Opening the popover reveals every folded attachment as its own chip.
    fireEvent.click(screen.getByText("Attachments"));
    expect(screen.getByText("Pasted 1")).toBeInTheDocument();
    expect(screen.getByText("Pasted 4")).toBeInTheDocument();
  });

  it("excludes background-job attachments from the fold and the count", () => {
    renderWithProviders(
      <AttachmentsList
        attachments={[
          textPaste(1),
          textPaste(2),
          textPaste(3),
          textPaste(4),
          bgJob("7"),
        ]}
        onRemove={() => {}}
      />,
    );
    // Count reflects the 4 foldable items, not 5.
    expect(screen.getByText("4")).toBeInTheDocument();
    // The background job renders inline as its own chip, outside the fold.
    expect(
      screen.getByText(backgroundJobDisplayName("7")),
    ).toBeInTheDocument();
  });

  it("removing from the popover uses the original array index", () => {
    const onRemove = vi.fn();
    // Background job first so foldable items start at original index 1.
    renderWithProviders(
      <AttachmentsList
        attachments={[
          bgJob("7"),
          textPaste(1),
          textPaste(2),
          textPaste(3),
          textPaste(4),
        ]}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByText("Attachments"));
    const row = screen.getByText("Pasted 1").closest("div") as HTMLElement;
    fireEvent.click(within(row).getByLabelText(/remove/i));
    // "Pasted 1" is at original index 1 (the bg job occupies index 0).
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
