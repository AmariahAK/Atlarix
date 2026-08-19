import express from "express";
import cors from "cors";
import { createChatCompletionHandler } from "./chatCompletionHandler";
import { mountScenarioRoutes } from "./scenario";
import {
  handleDeviceCode,
  handleAccessToken,
  handleUser,
  handleUserEmails,
  handleUserRepos,
  handleRepo,
  handleRepoBranches,
  handleOrgRepos,
  handleGitPush,
  handleGetPushEvents,
  handleClearPushEvents,
} from "./githubHandler";

/**
 * Build the fake-LLM express app without listening.
 *
 * index.ts (CLI entrypoint used by playwright's webServer) listens on :3500;
 * the agent-eval vitest harness imports createApp() and listens on an
 * ephemeral port instead.
 */
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  app.get("/health", (req, res) => {
    res.send("OK");
  });

  // Agent-eval scenario control surface (register / inspect / reset).
  mountScenarioRoutes(app);

  // Ollama-specific endpoints
  app.get("/ollama/api/tags", (req, res) => {
    const ollamaModels = {
      models: [
        {
          name: "testollama",
          modified_at: "2024-05-01T10:00:00.000Z",
          size: 4700000000,
          digest: "abcdef123456",
          details: {
            format: "gguf",
            family: "llama",
            families: ["llama"],
            parameter_size: "8B",
            quantization_level: "Q4_0",
          },
        },
        {
          name: "codellama:7b",
          modified_at: "2024-04-25T12:30:00.000Z",
          size: 3800000000,
          digest: "fedcba654321",
          details: {
            format: "gguf",
            family: "llama",
            families: ["llama", "codellama"],
            parameter_size: "7B",
            quantization_level: "Q5_K_M",
          },
        },
      ],
    };
    console.log("* Sending fake Ollama models");
    res.json(ollamaModels);
  });

  // LM Studio specific endpoints
  app.get("/lmstudio/api/v0/models", (req, res) => {
    const lmStudioModels = {
      data: [
        {
          type: "llm",
          id: "lmstudio-model-1",
          object: "model",
          publisher: "lmstudio",
          state: "loaded",
          max_context_length: 4096,
          quantization: "Q4_0",
          compatibility_type: "gguf",
          arch: "llama",
        },
        {
          type: "llm",
          id: "lmstudio-model-2-chat",
          object: "model",
          publisher: "lmstudio",
          state: "not-loaded",
          max_context_length: 8192,
          quantization: "Q5_K_M",
          compatibility_type: "gguf",
          arch: "mixtral",
        },
        {
          type: "embedding", // Should be filtered out by client
          id: "lmstudio-embedding-model",
          object: "model",
          publisher: "lmstudio",
          state: "loaded",
          max_context_length: 2048,
          quantization: "F16",
          compatibility_type: "gguf",
          arch: "bert",
        },
      ],
    };
    console.log("* Sending fake LM Studio models");
    res.json(lmStudioModels);
  });

  ["lmstudio", "gateway", "engine", "ollama", "azure"].forEach((provider) => {
    app.post(
      `/${provider}/v1/chat/completions`,
      createChatCompletionHandler(),
    );
  });

  // Azure-specific endpoints (Azure client uses different URL patterns)
  app.post("/azure/chat/completions", createChatCompletionHandler());
  app.post(
    "/azure/openai/deployments/:deploymentId/chat/completions",
    createChatCompletionHandler(),
  );

  // Default test provider handler:
  app.post("/v1/chat/completions", createChatCompletionHandler());

  // GitHub API Mock Endpoints
  console.log("Setting up GitHub mock endpoints");

  // GitHub OAuth Device Flow
  app.post("/github/login/device/code", handleDeviceCode);
  app.post("/github/login/oauth/access_token", handleAccessToken);

  // GitHub API endpoints
  app.get("/github/api/user", handleUser);
  app.get("/github/api/user/emails", handleUserEmails);
  app.get("/github/api/user/repos", handleUserRepos);
  app.post("/github/api/user/repos", handleUserRepos);
  app.get("/github/api/repos/:owner/:repo", handleRepo);
  app.get("/github/api/repos/:owner/:repo/branches", handleRepoBranches);
  app.post("/github/api/orgs/:org/repos", handleOrgRepos);

  // GitHub test endpoints for verifying push operations
  app.get("/github/api/test/push-events", handleGetPushEvents);
  app.post("/github/api/test/clear-push-events", handleClearPushEvents);

  // GitHub Git endpoints - intercept all paths with /github/git prefix
  app.all("/github/git/*", handleGitPush);

  return app;
}
