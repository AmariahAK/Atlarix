import { createServer } from "http";
import { createApp } from "./app";

// Re-export for backwards compatibility (chatCompletionHandler historically
// imported these from "."; they now live in the side-effect-free chunks.ts).
export { createStreamChunk, CANNED_MESSAGE } from "./chunks";
export { createApp } from "./app";

const PORT = 3500;

// Start the server
const server = createServer(createApp());
server.listen(PORT, () => {
  console.log(`Fake LLM server running on http://localhost:${PORT}`);
});

// Handle SIGINT (Ctrl+C)
process.on("SIGINT", () => {
  console.log("Shutting down fake LLM server");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
