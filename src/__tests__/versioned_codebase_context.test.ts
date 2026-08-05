import {
  parseFilesFromMessage,
  processChatMessagesWithVersionedFiles,
} from "@/ipc/utils/versioned_codebase_context";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import crypto from "node:crypto";

// Mock git_utils
vi.mock("@/ipc/utils/git_utils", () => ({
  getFileAtCommit: vi.fn(),
  getCurrentCommitHash: vi.fn().mockResolvedValue("mock-current-commit-hash"),
  isGitStatusClean: vi.fn().mockResolvedValue(true),
}));

// Mock electron-log
vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe("parseFilesFromMessage", () => {
  describe("atlarix-read tags", () => {
    it("should parse a single atlarix-read tag", () => {
      const input = '<atlarix-read path="src/components/Button.tsx"></atlarix-read>';
      const result = parseFilesFromMessage(input);
      expect(result).toEqual(["src/components/Button.tsx"]);
    });

    it("should parse multiple atlarix-read tags", () => {
      const input = `
        <atlarix-read path="src/components/Button.tsx"></atlarix-read>
        <atlarix-read path="src/utils/helpers.ts"></atlarix-read>
        <atlarix-read path="src/styles/main.css"></atlarix-read>
      `;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/utils/helpers.ts",
        "src/styles/main.css",
      ]);
    });

    it("should trim whitespace from file paths in atlarix-read tags", () => {
      const input =
        '<atlarix-read path="  src/components/Button.tsx  "></atlarix-read>';
      const result = parseFilesFromMessage(input);
      expect(result).toEqual(["src/components/Button.tsx"]);
    });

    it("should skip empty path attributes", () => {
      const input = `
        <atlarix-read path="src/components/Button.tsx"></atlarix-read>
        <atlarix-read path=""></atlarix-read>
        <atlarix-read path="src/utils/helpers.ts"></atlarix-read>
      `;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/utils/helpers.ts",
      ]);
    });

    it("should handle file paths with special characters", () => {
      const input =
        '<atlarix-read path="src/components/@special/Button-v2.tsx"></atlarix-read>';
      const result = parseFilesFromMessage(input);
      expect(result).toEqual(["src/components/@special/Button-v2.tsx"]);
    });
  });

  describe("atlarix-code-search-result tags", () => {
    it("should parse a single file from atlarix-code-search-result", () => {
      const input = `<atlarix-code-search-result>
src/components/Button.tsx
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual(["src/components/Button.tsx"]);
    });

    it("should parse multiple files from atlarix-code-search-result", () => {
      const input = `<atlarix-code-search-result>
src/components/Button.tsx
src/components/Input.tsx
src/utils/helpers.ts
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/components/Input.tsx",
        "src/utils/helpers.ts",
      ]);
    });

    it("should trim whitespace from each line", () => {
      const input = `<atlarix-code-search-result>
  src/components/Button.tsx  
    src/components/Input.tsx    
src/utils/helpers.ts
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/components/Input.tsx",
        "src/utils/helpers.ts",
      ]);
    });

    it("should skip empty lines in atlarix-code-search-result", () => {
      const input = `<atlarix-code-search-result>
src/components/Button.tsx

src/components/Input.tsx


src/utils/helpers.ts
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/components/Input.tsx",
        "src/utils/helpers.ts",
      ]);
    });

    it("should skip lines that look like tags (starting with < or >)", () => {
      const input = `<atlarix-code-search-result>
src/components/Button.tsx
<some-tag>
src/components/Input.tsx
>some-line
src/utils/helpers.ts
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/components/Input.tsx",
        "src/utils/helpers.ts",
      ]);
    });

    it("should handle multiple atlarix-code-search-result tags", () => {
      const input = `<atlarix-code-search-result>
src/components/Button.tsx
src/components/Input.tsx
</atlarix-code-search-result>

Some text in between

<atlarix-code-search-result>
src/utils/helpers.ts
src/styles/main.css
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/components/Input.tsx",
        "src/utils/helpers.ts",
        "src/styles/main.css",
      ]);
    });
  });

  describe("mixed tags", () => {
    it("should parse both atlarix-read and atlarix-code-search-result tags", () => {
      const input = `
<atlarix-read path="src/config/app.ts"></atlarix-read>

<atlarix-code-search-result>
src/components/Button.tsx
src/components/Input.tsx
</atlarix-code-search-result>

<atlarix-read path="src/utils/helpers.ts"></atlarix-read>
`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/config/app.ts",
        "src/components/Button.tsx",
        "src/components/Input.tsx",
        "src/utils/helpers.ts",
      ]);
    });

    it("should deduplicate file paths", () => {
      const input = `
<atlarix-read path="src/components/Button.tsx"></atlarix-read>
<atlarix-read path="src/components/Button.tsx"></atlarix-read>

<atlarix-code-search-result>
src/components/Button.tsx
src/utils/helpers.ts
</atlarix-code-search-result>
`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Button.tsx",
        "src/utils/helpers.ts",
      ]);
    });

    it("should handle complex real-world example", () => {
      const input = `
Here's what I found:

<atlarix-read path="src/components/Header.tsx"></atlarix-read>

I also searched for related files:

<atlarix-code-search-result>
src/components/Header.tsx
src/components/Footer.tsx
src/styles/layout.css
</atlarix-code-search-result>

Let me also check the config:

<atlarix-read path="src/config/site.ts"></atlarix-read>

And finally:

<atlarix-code-search-result>
src/utils/navigation.ts
src/utils/theme.ts
</atlarix-code-search-result>
`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/components/Header.tsx",
        "src/components/Footer.tsx",
        "src/styles/layout.css",
        "src/config/site.ts",
        "src/utils/navigation.ts",
        "src/utils/theme.ts",
      ]);
    });
  });

  describe("edge cases", () => {
    it("should return empty array for empty string", () => {
      const input = "";
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([]);
    });

    it("should return empty array when no tags present", () => {
      const input = "This is just some regular text without any tags.";
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([]);
    });

    it("should handle malformed tags gracefully", () => {
      const input = `
<atlarix-read path="src/file1.ts"
<atlarix-code-search-result>
src/file2.ts
`;
      const result = parseFilesFromMessage(input);
      // Should not match unclosed tags
      expect(result).toEqual([]);
    });

    it("should handle nested angle brackets in file paths", () => {
      const input =
        '<atlarix-read path="src/components/Generic<T>.tsx"></atlarix-read>';
      const result = parseFilesFromMessage(input);
      expect(result).toEqual(["src/components/Generic<T>.tsx"]);
    });

    it("should preserve file path case sensitivity", () => {
      const input = `<atlarix-code-search-result>
src/Components/Button.tsx
src/components/button.tsx
SRC/COMPONENTS/BUTTON.TSX
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "src/Components/Button.tsx",
        "src/components/button.tsx",
        "SRC/COMPONENTS/BUTTON.TSX",
      ]);
    });

    it("should handle very long file paths", () => {
      const longPath =
        "src/very/deeply/nested/directory/structure/with/many/levels/components/Button.tsx";
      const input = `<atlarix-read path="${longPath}"></atlarix-read>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([longPath]);
    });

    it("should handle file paths with dots", () => {
      const input = `<atlarix-code-search-result>
./src/components/Button.tsx
../utils/helpers.ts
../../config/app.config.ts
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "./src/components/Button.tsx",
        "../utils/helpers.ts",
        "../../config/app.config.ts",
      ]);
    });

    it("should handle absolute paths", () => {
      const input = `<atlarix-code-search-result>
/absolute/path/to/file.tsx
/another/absolute/path.ts
</atlarix-code-search-result>`;
      const result = parseFilesFromMessage(input);
      expect(result).toEqual([
        "/absolute/path/to/file.tsx",
        "/another/absolute/path.ts",
      ]);
    });
  });
});

describe("processChatMessagesWithVersionedFiles", () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  // Helper to compute SHA-256 hash
  const hashContent = (content: string): string => {
    return crypto.createHash("sha256").update(content).digest("hex");
  };

  describe("basic functionality", () => {
    it("should handle empty files array", async () => {
      const chatMessages: ModelMessage[] = [];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(result.fileIdToContent).toEqual({});
      expect(result.fileReferences).toEqual([]);
      expect(result.messageIndexToFilePathToFileId).toEqual({});
    });
  });

  describe("processing assistant messages", () => {
    it("should process assistant messages with sourceCommitHash", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const fileContent = "const oldVersion = 'content';";
      mockGetFileAtCommit.mockResolvedValue(fileContent);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content:
            'I found this file: <atlarix-read path="src/old.ts"></atlarix-read>',
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "abc123",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      // Verify getFileAtCommit was called correctly
      expect(mockGetFileAtCommit).toHaveBeenCalledWith({
        path: appPath,
        filePath: "src/old.ts",
        commitHash: "abc123",
      });

      // Check fileIdToContent
      const fileHash = hashContent(fileContent);
      expect(result.fileIdToContent[fileHash]).toBe(fileContent);

      // Check messageIndexToFilePathToFileId
      expect(result.messageIndexToFilePathToFileId[0]).toEqual({
        "src/old.ts": fileHash,
      });
    });

    it("should process messages with array content type", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const fileContent = "const arrayContent = 'test';";
      mockGetFileAtCommit.mockResolvedValue(fileContent);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: 'Here is the file: <atlarix-read path="src/array.ts"></atlarix-read>',
            },
            {
              type: "text",
              text: "Additional text",
            },
          ],
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "def456",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).toHaveBeenCalledWith({
        path: appPath,
        filePath: "src/array.ts",
        commitHash: "def456",
      });

      const fileHash = hashContent(fileContent);
      expect(result.fileIdToContent[fileHash]).toBe(fileContent);
      expect(result.messageIndexToFilePathToFileId[0]["src/array.ts"]).toBe(
        fileHash,
      );
    });

    it("should skip user messages", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const chatMessages: ModelMessage[] = [
        {
          role: "user",
          content:
            'Check this: <atlarix-read path="src/user-file.ts"></atlarix-read>',
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      // getFileAtCommit should not be called for user messages
      expect(mockGetFileAtCommit).not.toHaveBeenCalled();
      expect(result.messageIndexToFilePathToFileId).toEqual({});
    });

    it("should skip assistant messages without sourceCommitHash", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: 'File here: <atlarix-read path="src/no-commit.ts"></atlarix-read>',
          // No providerOptions
        },
        {
          role: "assistant",
          content:
            'Another file: <atlarix-read path="src/no-commit2.ts"></atlarix-read>',
          providerOptions: {
            // dyad-engine not set
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).not.toHaveBeenCalled();
      expect(result.messageIndexToFilePathToFileId).toEqual({});
    });

    it("should skip messages with non-text content", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: [],
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "abc123",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).not.toHaveBeenCalled();
      expect(result.messageIndexToFilePathToFileId).toEqual({});
    });
  });

  describe("parsing multiple file paths", () => {
    it("should process multiple files from atlarix-code-search-result", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const file1Content = "file1 content";
      const file2Content = "file2 content";

      mockGetFileAtCommit
        .mockResolvedValueOnce(file1Content)
        .mockResolvedValueOnce(file2Content);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: `<atlarix-code-search-result>
src/file1.ts
src/file2.ts
</atlarix-code-search-result>`,
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "commit1",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).toHaveBeenCalledTimes(2);
      expect(mockGetFileAtCommit).toHaveBeenCalledWith({
        path: appPath,
        filePath: "src/file1.ts",
        commitHash: "commit1",
      });
      expect(mockGetFileAtCommit).toHaveBeenCalledWith({
        path: appPath,
        filePath: "src/file2.ts",
        commitHash: "commit1",
      });

      const file1Hash = hashContent(file1Content);
      const file2Hash = hashContent(file2Content);

      expect(result.fileIdToContent[file1Hash]).toBe(file1Content);
      expect(result.fileIdToContent[file2Hash]).toBe(file2Content);

      expect(result.messageIndexToFilePathToFileId[0]).toEqual({
        "src/file1.ts": file1Hash,
        "src/file2.ts": file2Hash,
      });
    });

    it("should process mixed atlarix-read and atlarix-code-search-result tags", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      mockGetFileAtCommit
        .mockResolvedValueOnce("file1")
        .mockResolvedValueOnce("file2")
        .mockResolvedValueOnce("file3");

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: `
<atlarix-read path="src/file1.ts"></atlarix-read>

<atlarix-code-search-result>
src/file2.ts
src/file3.ts
</atlarix-code-search-result>
`,
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "hash1",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).toHaveBeenCalledTimes(3);
      expect(Object.keys(result.messageIndexToFilePathToFileId[0])).toEqual([
        "src/file1.ts",
        "src/file2.ts",
        "src/file3.ts",
      ]);
    });
  });

  describe("error handling", () => {
    it("should handle file not found (returns null)", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      // Simulate file not found
      mockGetFileAtCommit.mockResolvedValue(null);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content:
            'Missing file: <atlarix-read path="src/missing.ts"></atlarix-read>',
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "commit1",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).toHaveBeenCalled();

      // File should not be in results
      expect(result.fileIdToContent).toEqual({});
      expect(result.messageIndexToFilePathToFileId[0]).toEqual({});
    });

    it("should handle getFileAtCommit throwing an error", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      // Simulate error
      mockGetFileAtCommit.mockRejectedValue(new Error("Git error"));

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: 'Error file: <atlarix-read path="src/error.ts"></atlarix-read>',
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "commit1",
            },
          },
        },
      ];
      const appPath = "/test/app";

      // Should not throw - errors are caught and logged
      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).toHaveBeenCalled();
      expect(result.fileIdToContent).toEqual({});
      expect(result.messageIndexToFilePathToFileId[0]).toEqual({});
    });

    it("should process some files successfully and skip others that error", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const successContent = "success file";

      mockGetFileAtCommit
        .mockResolvedValueOnce(successContent)
        .mockRejectedValueOnce(new Error("Error"))
        .mockResolvedValueOnce(null);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: `<atlarix-code-search-result>
src/success.ts
src/error.ts
src/missing.ts
</atlarix-code-search-result>`,
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "commit1",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).toHaveBeenCalledTimes(3);

      // Only the successful file should be in results
      const successHash = hashContent(successContent);
      expect(result.fileIdToContent[successHash]).toBe(successContent);
      expect(result.messageIndexToFilePathToFileId[0]).toEqual({
        "src/success.ts": successHash,
      });
    });
  });

  describe("multiple messages", () => {
    it("should process multiple messages with different commits", async () => {
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const file1AtCommit1 = "file1 at commit1";
      const file1AtCommit2 = "file1 at commit2 - different content";

      mockGetFileAtCommit
        .mockResolvedValueOnce(file1AtCommit1)
        .mockResolvedValueOnce(file1AtCommit2);

      const chatMessages: ModelMessage[] = [
        {
          role: "user",
          content: "Show me file1",
        },
        {
          role: "assistant",
          content: 'Here it is: <atlarix-read path="src/file1.ts"></atlarix-read>',
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "commit1",
            },
          },
        },
        {
          role: "user",
          content: "Show me it again",
        },
        {
          role: "assistant",
          content:
            'Here it is again: <atlarix-read path="src/file1.ts"></atlarix-read>',
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "commit2",
            },
          },
        },
      ];
      const appPath = "/test/app";

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath,
      });

      expect(mockGetFileAtCommit).toHaveBeenCalledTimes(2);
      expect(mockGetFileAtCommit).toHaveBeenNthCalledWith(1, {
        path: appPath,
        filePath: "src/file1.ts",
        commitHash: "commit1",
      });
      expect(mockGetFileAtCommit).toHaveBeenNthCalledWith(2, {
        path: appPath,
        filePath: "src/file1.ts",
        commitHash: "commit2",
      });

      const hash1 = hashContent(file1AtCommit1);
      const hash2 = hashContent(file1AtCommit2);

      // Both versions should be in fileIdToContent
      expect(result.fileIdToContent[hash1]).toBe(file1AtCommit1);
      expect(result.fileIdToContent[hash2]).toBe(file1AtCommit2);

      // Message index 1 (first assistant message)
      expect(result.messageIndexToFilePathToFileId[1]).toEqual({
        "src/file1.ts": hash1,
      });

      // Message index 3 (second assistant message)
      expect(result.messageIndexToFilePathToFileId[3]).toEqual({
        "src/file1.ts": hash2,
      });
    });
  });

  describe("versioned files from message history", () => {
    it("resolves a path named in an assistant message at that turn's commit", async () => {
      // Was "should combine files parameter with versioned files from messages".
      // The `files` half is gone — it was fed by an array `chat_stream_handlers`
      // hardcoded to `[]`. What remains is the half that does real work.
      const { getFileAtCommit } = await import("@/ipc/utils/git_utils");
      const mockGetFileAtCommit = vi.mocked(getFileAtCommit);

      const versionedContent = "old version from git";
      mockGetFileAtCommit.mockResolvedValue(versionedContent);

      const chatMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: 'Old version: <atlarix-read path="src/old.ts"></atlarix-read>',
          providerOptions: {
            "dyad-engine": {
              sourceCommitHash: "abc123",
            },
          },
        },
      ];

      const result = await processChatMessagesWithVersionedFiles({
        chatMessages,
        appPath: "/test/app",
      });

      const oldHash = hashContent(versionedContent);
      expect(result.fileIdToContent[oldHash]).toBe(versionedContent);
      // `fileReferences` was only ever populated by the deleted loop.
      expect(result.fileReferences).toHaveLength(0);
      expect(result.messageIndexToFilePathToFileId[0]).toEqual({
        "src/old.ts": oldHash,
      });
    });
  });
});
