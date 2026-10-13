import { describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({ default: { scope: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }));
import { ollamaDisplayName } from "@/ipc/handlers/local_model_ollama_handler";

describe("Ollama model names", () => {
  it("keeps the size and the version's dot, so 3b and 7b differ", () => {
    expect(ollamaDisplayName("qwen2.5:3b")).toBe("Qwen2.5 3B");
    expect(ollamaDisplayName("qwen2.5:7b")).toBe("Qwen2.5 7B");
    expect(ollamaDisplayName("llama3.1:8b-instruct-q4_K_M")).toBe("Llama3.1 8B Instruct Q4 K M");
    expect(ollamaDisplayName("deepseek-r1:latest")).toBe("Deepseek R1");
    expect(ollamaDisplayName("hf.co/user/gemma-3:12b")).toBe("Gemma 3 12B");
  });
});
