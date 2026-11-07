/** @jsxImportSource @opentui/react */
/**
 * The prompt box. Enter sends; shift+enter, ctrl+j or a backslash then enter add a line. Pastes and
 * dropped paths become atomic placeholders — `[Pasted text #1 +214 lines]`,
 * `[Image #1]`, `[File …]`, `[Folder …]` — that backspace removes whole (they are
 * virtual extmarks, opencode's mechanism). The rules live in ../composer/model.ts.
 */
import { decodePasteBytes, type PasteEvent, type TextareaRenderable } from "@opentui/core";
import { useEffect, useRef, type MutableRefObject } from "react";
import {
  buildSubmission,
  classifyPaste,
  freshCounters,
  labelFor,
  placeholdersInText,
  type Placeholder,
  type Submission,
} from "../composer/model";
import { COMMANDS } from "./commands";
import { color, syntax } from "./theme";

export interface ComposerApi {
  text(): string;
  clear(): void;
  setText(text: string): void;
  /** Set the text and restore these chips in it (history recall). */
  setDraft(text: string, placeholders: Placeholder[]): void;
  /** What would be sent right now (placeholders expanded). */
  submission(): Submission;
  focus(): void;
  /** The text up to the cursor (what `@` completes). */
  beforeCursor(): string;
  /** Replace the `n` characters before the cursor with `text` (choosing an `@` match). */
  replaceBeforeCursor(n: number, text: string): void;
  /** Whether the screen cell (x, y) is inside the text area. */
  contains(x: number, y: number): boolean;
  /** Put the cursor on the character at screen cell (x, y): past a line's end means its end. */
  placeCursorAt(x: number, y: number): void;
}

/** The highlights this box adds itself, removed together by this ref. */
const PROMPT_HL = 7;

/**
 * Colour what the box will do with the text: a /command it knows, or the "!"
 * that runs a shell command. Re-done on every change (one short range).
 */
export function paintCommand(t: TextareaRenderable | null | undefined): void {
  if (!t) return;
  t.removeHighlightsByRef(PROMPT_HL);
  const text = t.plainText;
  const word = /^\/[\w-]+/.exec(text)?.[0];
  if (word && COMMANDS.some((c) => c.name === word)) {
    const styleId = syntax.getStyleId("prompt.command");
    if (styleId != null) t.addHighlightByCharRange({ start: 0, end: word.length, styleId, hlRef: PROMPT_HL });
  } else if (text.startsWith("!")) {
    const styleId = syntax.getStyleId("prompt.shell");
    if (styleId != null) t.addHighlightByCharRange({ start: 0, end: 1, styleId, hlRef: PROMPT_HL });
  }
}

export function Composer({
  apiRef,
  onSubmit,
  onChange,
  placeholder,
  focused,
  borderColor,
  shell = false,
  title,
  bottomTitle,
}: {
  apiRef: MutableRefObject<ComposerApi | null>;
  onSubmit: (s: Submission) => void;
  onChange?: (text: string) => void;
  placeholder: string;
  focused: boolean;
  borderColor: string;
  /** The box holds a `!command`: drawn as a shell prompt. */
  shell?: boolean;
  /** Text set into the top border (left) — the status line. */
  title?: string;
  /** Text set into the bottom border (right) — the folder and key hints. */
  bottomTitle?: string;
}) {
  const ta = useRef<TextareaRenderable | null>(null);
  const placeholders = useRef<Placeholder[]>([]);
  const counters = useRef(freshCounters());
  const typeId = useRef(0);
  /** Each placeholder's extmark, by label: re-pasting the same text expands it. */
  const marks = useRef(new Map<string, number>());

  const reset = () => {
    marks.current.clear();
    ta.current?.extmarks.clear();
    ta.current?.setText("");
    placeholders.current = [];
    counters.current = freshCounters();
    onChange?.("");
  };

  useEffect(() => {
    apiRef.current = {
      text: () => ta.current?.plainText ?? "",
      clear: reset,
      // A label still in the new text must keep its chip: wiping the record
      // would send the paste as its literal label on submit (0ab).
      setText: (t) => setDraft(t, placeholdersInText(placeholders.current, t)),
      setDraft: (t, restore) => setDraft(t, restore),
      submission: () => buildSubmission(ta.current?.plainText ?? "", placeholders.current),
      focus: () => ta.current?.focus(),
      beforeCursor: () => {
        const input = ta.current;
        return input ? input.plainText.slice(0, input.cursorOffset) : "";
      },
      replaceBeforeCursor: (n, text) => {
        const input = ta.current;
        if (!input) return;
        for (let i = 0; i < n; i++) input.deleteCharBackward();
        input.insertText(text);
        onChange?.(input.plainText);
      },
      contains: (x, y) => {
        const input = ta.current;
        return !!input && x >= input.x && x < input.x + input.width && y >= input.y && y < input.y + input.height;
      },
      placeCursorAt: (x, y) => {
        const input = ta.current;
        if (!input) return;
        // opentui's own cell-to-text mapping, the one its drag selection uses:
        // it knows the wrapping, the scroll and wide characters. An empty
        // selection that moves the cursor, then dropped.
        const lx = x - input.x;
        const ly = y - input.y;
        input.editorView.setLocalSelection(lx, ly, lx, ly, undefined, undefined, true, false);
        input.editorView.resetLocalSelection();
        input.requestRender();
      },
    };
  });

  /** Set the box's text, re-registering any chip whose label it still carries. */
  const setDraft = (t: string, restore: Placeholder[]) => {
    reset();
    if (!t) return;
    ta.current?.insertText(t);
    const kept = placeholdersInText(restore, t);
    for (const { label, attachment } of kept) {
      placeholders.current.push({ label, attachment });
      const start = t.indexOf(label);
      if (!typeId.current) typeId.current = ta.current!.extmarks.registerType("prompt-part");
      const style =
        syntax.getStyleId(
          attachment.kind === "paste" ? "extmark.paste" : attachment.kind === "image" ? "extmark.image" : "extmark.file",
        ) ?? undefined;
      const id = ta.current!.extmarks.create({
        start,
        end: start + label.length,
        virtual: true,
        styleId: style,
        typeId: typeId.current,
      });
      marks.current.set(label, id);
      // A restored #2 must not collide with a fresh paste also numbered #2.
      if (attachment.kind === "paste") counters.current.paste = Math.max(counters.current.paste, attachment.n);
      if (attachment.kind === "image") counters.current.image = Math.max(counters.current.image, attachment.n);
    }
    onChange?.(t);
  };

  const onPaste = (event: PasteEvent) => {
    const input = ta.current;
    if (!input) return;
    const text = decodePasteBytes(event.bytes).replace(/\r\n?/g, "\n");
    // Pasting the same text again opens its "[Pasted text #N]" chip into the
    // full text, to edit in place (as Claude Code does; owner, 2026-10-05).
    const same = placeholders.current.find((p) => p.attachment.kind === "paste" && p.attachment.text === text);
    const markId = same ? marks.current.get(same.label) : undefined;
    const mark = markId != null ? input.extmarks.get(markId) : null;
    if (same && mark) {
      event.preventDefault();
      input.extmarks.delete(mark.id);
      marks.current.delete(same.label);
      placeholders.current = placeholders.current.filter((p) => p !== same);
      input.cursorOffset = mark.end;
      for (let i = mark.start; i < mark.end; i++) input.deleteCharBackward();
      input.insertText(text);
      onChange?.(input.plainText);
      return;
    }
    const attachment = classifyPaste(text, counters.current);
    if (!attachment) return; // plain text: the textarea inserts it itself
    event.preventDefault();
    const label = labelFor(attachment);
    placeholders.current.push({ label, attachment });
    const start = input.cursorOffset;
    input.insertText(label + " ");
    if (!typeId.current) typeId.current = input.extmarks.registerType("prompt-part");
    const style =
      syntax.getStyleId(
        attachment.kind === "paste" ? "extmark.paste" : attachment.kind === "image" ? "extmark.image" : "extmark.file",
      ) ?? undefined;
    const id = input.extmarks.create({
      start,
      end: start + label.length,
      virtual: true,
      styleId: style,
      typeId: typeId.current,
    });
    marks.current.set(label, id);
    onChange?.(input.plainText);
  };

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={shell ? color.code : borderColor}
      title={title}
      titleAlignment="left"
      titleColor={color.textDim}
      bottomTitle={bottomTitle}
      bottomTitleAlignment="right"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
      flexShrink={0}
      // One step up from the page: the box reads as where you type, not as
      // another line of output (owner, 2026-10-05: "a small elevation").
      backgroundColor={color.raised}
    >
      <text fg={shell ? color.code : color.accent}>› </text>
      <textarea
        ref={ta}
        flexGrow={1}
        minHeight={1}
        maxHeight={10}
        focused={focused}
        placeholder={placeholder}
        placeholderColor={color.faint}
        textColor={color.text}
        focusedTextColor={color.text}
        backgroundColor={color.raised}
        focusedBackgroundColor={color.raised}
        cursorColor={color.text}
        syntaxStyle={syntax}
        wrapMode="word"
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "return", shift: true, action: "newline" },
          { name: "return", meta: true, action: "newline" },
          { name: "j", ctrl: true, action: "newline" },
        ]}
        onPaste={onPaste}
        onContentChange={() => {
          paintCommand(ta.current);
          onChange?.(ta.current?.plainText ?? "");
        }}
        onSubmit={() => {
          // "\" then enter adds a line, in any terminal. Apple's Terminal sends
          // shift+enter as a plain enter (and option+enter too, unless "Use
          // Option as Meta key" is on), so nothing can tell them apart there.
          const t = ta.current;
          if (t && t.plainText.slice(0, t.cursorOffset).endsWith("\\")) {
            t.deleteCharBackward();
            t.newLine();
            return;
          }
          const s = buildSubmission(ta.current?.plainText ?? "", placeholders.current);
          if (!s.display) return;
          onSubmit(s);
        }}
      />
    </box>
  );
}
