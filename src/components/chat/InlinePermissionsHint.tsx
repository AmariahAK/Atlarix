/** Shown in the right panel when permissions tab is selected; approvals live in chat. */
export function InlinePermissionsHint() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      File and command approvals appear inline in the chat while the assistant is working.
    </div>
  );
}
