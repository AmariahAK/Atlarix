export function isStreamDebugLoggingEnabled(): boolean {
  return (
    process.env.ATLARIX_STREAM_DEBUG === "1" || process.env.NODE_ENV === "test"
  );
}
