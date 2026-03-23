import type { IpcRenderer } from "electron";
import {
  type ChatSummary,
  ChatSummariesSchema,
  type UserSettings,
  type ContextPathResults,
  ChatSearchResultsSchema,
  AppSearchResultsSchema,
} from "../lib/schemas";
import type {
  AppOutput,
  Chat,
  ChatResponseEnd,
  ChatProblemsEvent,
  CreateAppParams,
  CreateAppResult,
  ListAppsResponse,
  NodeSystemInfo,
  Message,
  Version,
  SystemDebugInfo,
  LocalModel,
  LocalModelListResponse,
  TokenCountParams,
  TokenCountResult,
  ChatLogsData,
  BranchResult,
  LanguageModelProvider,
  LanguageModel,
  CreateCustomLanguageModelProviderParams,
  CreateCustomLanguageModelParams,
  DoesReleaseNoteExistParams,
  ApproveProposalResult,
  ImportAppResult,
  ImportAppParams,
  RenameBranchParams,
  UserBudgetInfo,
  CopyAppParams,
  App,
  ComponentSelection,
  AppUpgrade,
  ProblemReport,
  EditAppFileReturnType,
  GetAppEnvVarsParams,
  SetAppEnvVarsParams,
  ConnectToExistingVercelProjectParams,
  IsVercelProjectAvailableResponse,
  CreateVercelProjectParams,
  VercelDeployment,
  GetVercelDeploymentsParams,
  DisconnectVercelProjectParams,
  SecurityReviewResult,
  IsVercelProjectAvailableParams,
  SaveVercelAccessTokenParams,
  VercelProject,
  UpdateChatParams,
  FileAttachment,
  CreateNeonProjectParams,
  NeonProject,
  GetNeonProjectParams,
  GetNeonProjectResponse,
  RevertVersionResponse,
  RevertVersionParams,
  RespondToAppInputParams,
  PromptDto,
  CreatePromptParamsDto,
  UpdatePromptParamsDto,
  McpServerUpdate,
  CreateMcpServer,
  CloneRepoParams,
  SupabaseBranch,
  SetSupabaseAppProjectParams,
  SelectNodeFolderResult,
  ApplyVisualEditingChangesParams,
  AnalyseComponentParams,
  type DiscordInviteInfoResult,
} from "./ipc_types";
import type { Question } from "./ipc_types";
import type { Template } from "../shared/templates";
import type {
  AppChatContext,
  AppSearchResult,
  ChatSearchResult,
  ProposalResult,
} from "@/lib/schemas";
import { showError } from "@/lib/toast";
import { DeepLinkData } from "./deep_link_data";

export interface ChatStreamCallbacks {
  onUpdate: (messages: Message[]) => void;
  onEnd: (response: ChatResponseEnd) => void;
  onError: (error: string) => void;
}

export interface AppStreamCallbacks {
  onOutput: (output: AppOutput) => void;
}

export interface GitHubDeviceFlowUpdateData {
  userCode?: string;
  verificationUri?: string;
  message?: string;
}

export interface GitHubDeviceFlowSuccessData {
  message?: string;
}

export interface GitHubDeviceFlowErrorData {
  error: string;
}

interface DeleteCustomModelParams {
  providerId: string;
  modelApiName: string;
}

export class IpcClient {
  private static instance: IpcClient;
  private ipcRenderer: IpcRenderer;
  private chatStreams: Map<number, ChatStreamCallbacks>;
  private appStreams: Map<number, AppStreamCallbacks>;
  private helpStreams: Map<
    string,
    {
      onChunk: (delta: string) => void;
      onEnd: () => void;
      onError: (error: string) => void;
    }
  >;
  private mcpConsentHandlers: Map<string, (payload: any) => void>;
  private permissionHandlers: Map<number, (payload: any) => void>;
  private modeChangeHandler: ((payload: { chatId: number; requestedMode: string; reason: string }) => void) | null = null;
  private diagramHandlers: Map<number, (payload: any) => void>;
  private terminalHandlers: Map<number, (payload: any) => void>;
  private toolStartHandlers: Set<(payload: { chatId: number; toolName: string }) => void> = new Set();
  private toolEndHandlers: Set<(payload: { chatId: number }) => void> = new Set();
  private chatActivityHandlers: Set<(payload: { label?: string; status?: string; chatId?: number }) => void> = new Set();
  /** v3.9: Clarifying questions from AI — handlers receive { messageId, questions }. */
  private questionsHandlers: Set<(payload: { messageId: number; questions: Question[] }) => void> = new Set();
  private constructor() {
    this.ipcRenderer = (window as any).electron.ipcRenderer as IpcRenderer;
    this.chatStreams = new Map();
    this.appStreams = new Map();
    this.helpStreams = new Map();
    this.mcpConsentHandlers = new Map();
    this.permissionHandlers = new Map();
    this.diagramHandlers = new Map();
    this.terminalHandlers = new Map();
    // Set up listeners for stream events
    this.ipcRenderer.on("chat:response:chunk", (data) => {
      if (
        data &&
        typeof data === "object" &&
        "chatId" in data
      ) {
        const { chatId } = data as { chatId: number };

        // Handle permission-request type
        if ("type" in data && (data as any).type === "permission-request") {
          const handler = this.permissionHandlers.get(chatId);
          if (handler) {
            handler(data);
          }
          return;
        }

        // Handle normal message updates
        if ("messages" in data) {
          const { messages } = data as { chatId: number; messages: Message[] };
          const callbacks = this.chatStreams.get(chatId);
          if (callbacks) {
            callbacks.onUpdate(messages);
          } else {
            console.warn(
              `[IPC] No callbacks found for chat ${chatId}`,
              this.chatStreams,
            );
          }
        }
      } else {
        showError(new Error(`[IPC] Invalid chunk data received: ${data}`));
      }
    });

    this.ipcRenderer.on("app:output", (data) => {
      if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        "message" in data &&
        "appId" in data
      ) {
        const { type, message, appId } = data as unknown as AppOutput;
        const callbacks = this.appStreams.get(appId);
        if (callbacks) {
          callbacks.onOutput({ type, message, appId, timestamp: Date.now() });
        }
      } else {
        showError(new Error(`[IPC] Invalid app output data received: ${data}`));
      }
    });

    this.ipcRenderer.on("chat:response:end", (payload) => {
      const { chatId } = payload as unknown as ChatResponseEnd;
      const callbacks = this.chatStreams.get(chatId);
      if (callbacks) {
        callbacks.onEnd(payload as unknown as ChatResponseEnd);
        console.debug("chat:response:end");
        this.chatStreams.delete(chatId);
      } else {
        // This is expected when canceling streams or for ephemeral chats (-1)
        console.debug(
          `[IPC] Stream ended without callbacks for chat ${chatId} (expected after cancel)`,
        );
      }
    });

    this.ipcRenderer.on("chat:tool:start", (payload: unknown) => {
      if (payload && typeof payload === "object" && "chatId" in payload && "toolName" in payload) {
        const { chatId, toolName } = payload as { chatId: number; toolName: string };
        this.toolStartHandlers.forEach((h) => h({ chatId, toolName }));
      }
    });
    this.ipcRenderer.on("chat:tool:end", (payload: unknown) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload as { chatId: number };
        this.toolEndHandlers.forEach((h) => h({ chatId }));
      }
    });

    this.ipcRenderer.on("chat:response:error", (payload) => {
      console.debug("chat:response:error");
      if (
        payload &&
        typeof payload === "object" &&
        "chatId" in payload &&
        "error" in payload
      ) {
        const { chatId, error } = payload as { chatId: number; error: string };
        const callbacks = this.chatStreams.get(chatId);
        if (callbacks) {
          callbacks.onError(error);
          this.chatStreams.delete(chatId);
        } else {
          console.warn(
            `[IPC] No callbacks found for chat ${chatId} on error`,
            this.chatStreams,
          );
        }
      } else {
        console.error("[IPC] Invalid error data received:", payload);
      }
    });

    // Help bot events
    this.ipcRenderer.on("help:chat:response:chunk", (data) => {
      if (
        data &&
        typeof data === "object" &&
        "sessionId" in data &&
        "delta" in data
      ) {
        const { sessionId, delta } = data as {
          sessionId: string;
          delta: string;
        };
        const callbacks = this.helpStreams.get(sessionId);
        if (callbacks) callbacks.onChunk(delta);
      }
    });

    this.ipcRenderer.on("help:chat:response:end", (data) => {
      if (data && typeof data === "object" && "sessionId" in data) {
        const { sessionId } = data as { sessionId: string };
        const callbacks = this.helpStreams.get(sessionId);
        if (callbacks) callbacks.onEnd();
        this.helpStreams.delete(sessionId);
      }
    });
    this.ipcRenderer.on("help:chat:response:error", (data) => {
      if (
        data &&
        typeof data === "object" &&
        "sessionId" in data &&
        "error" in data
      ) {
        const { sessionId, error } = data as {
          sessionId: string;
          error: string;
        };
        const callbacks = this.helpStreams.get(sessionId);
        if (callbacks) callbacks.onError(error);
        this.helpStreams.delete(sessionId);
      }
    });

    // MCP tool consent request from main
    this.ipcRenderer.on("mcp:tool-consent-request", (payload) => {
      const handler = this.mcpConsentHandlers.get("consent");
      if (handler) handler(payload);
    });

    // Permission request from main (Build mode tools needing approval)
    this.ipcRenderer.on("permission-request", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload;
        const handler = this.permissionHandlers.get(chatId);
        if (handler) {
          handler(payload);
        } else {
          console.warn(`[IPC] No permission handler for chat ${chatId}`);
        }
      }
    });

    // Mode change request (Ask -> Build; user approval required)
    this.ipcRenderer.on("mode_change_requested", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload && this.modeChangeHandler) {
        this.modeChangeHandler(payload);
      }
    });

    // Workspace diagram from main (diagram tool results)
    this.ipcRenderer.on("chat:workspace-diagram", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload;
        const handler = this.diagramHandlers.get(chatId);
        if (handler) {
          handler(payload);
        }
      }
    });

    // Terminal output from main (command execution)
    this.ipcRenderer.on("terminal-output", (payload: any) => {
      if (payload && typeof payload === "object" && "chatId" in payload) {
        const { chatId } = payload;
        const handler = this.terminalHandlers.get(chatId);
        if (handler) {
          handler(payload);
        } else {
          console.log("[IPC] Terminal output received:", payload);
        }
      }
    });

    // chat:activity (e.g. summarization progress)
    this.ipcRenderer.on("chat:activity", (payload: any) => {
      if (payload && typeof payload === "object") {
        this.chatActivityHandlers.forEach((h) => h(payload));
      }
    });

    // v3.9: Clarifying questions from AI (<questions> block)
    this.ipcRenderer.on("chat:questions", (payload: unknown) => {
      if (payload && typeof payload === "object" && "messageId" in payload && "questions" in payload) {
        const { messageId, questions } = payload as { messageId: number; questions: Question[] };
        this.questionsHandlers.forEach((h) => h({ messageId, questions }));
      }
    });
  }

  /** v3.9: Register for clarifying questions. Returns unsubscribe. */
  public onQuestions(handler: (payload: { messageId: number; questions: Question[] }) => void): () => void {
    this.questionsHandlers.add(handler);
    return () => this.questionsHandlers.delete(handler);
  }

  /** v3.9: Submit clarifying-question answers and mark chat as answered (backend appends to user message). */
  public async submitQuestionAnswers(
    chatId: number,
    assistantMessageId: number,
    answers: Record<string, string>
  ): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("chat:submit-question-answers", {
      chatId,
      assistantMessageId,
      answers,
    });
  }

  /** v3.9: Edit user message, truncate after it, clear has_answered_questions. */
  public async editMessage(
    chatId: number,
    userMessageId: number,
    newContent: string
  ): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("chat:edit-message", {
      chatId,
      userMessageId,
      newContent,
    });
  }

  /** v3.9: Revert conversation to assistant message, truncate after it, clear has_answered_questions. */
  public async revertToMessage(
    chatId: number,
    assistantMessageId: number
  ): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("chat:revert-to-message", {
      chatId,
      assistantMessageId,
    });
  }

  /** v3.9: GitHub Actions — list runs for workspace */
  public async githubActionsListRuns(workspacePath: string): Promise<{
    repo: { owner: string; repo: string } | null;
    runs: Array<{
      id: number;
      name: string;
      headBranch: string;
      status: string;
      conclusion: string | null;
      createdAt: Date;
      htmlUrl?: string;
    }>;
  }> {
    return this.ipcRenderer.invoke("github-actions:list-runs", workspacePath);
  }

  /** v3.9: GitHub Actions — get jobs for a run */
  public async githubActionsGetJobs(
    owner: string,
    repo: string,
    runId: number
  ): Promise<Array<{ id: number; name: string; status: string; conclusion: string | null; steps: unknown[]; htmlUrl?: string }>> {
    return this.ipcRenderer.invoke("github-actions:get-jobs", owner, repo, runId);
  }

  /** v3.9: GitHub Actions — get job logs */
  public async githubActionsGetLogs(
    owner: string,
    repo: string,
    jobId: number
  ): Promise<string> {
    return this.ipcRenderer.invoke("github-actions:get-logs", owner, repo, jobId);
  }

  /** v3.9: GitHub Actions — start log stream (emits github-actions:log-chunk) */
  public async githubActionsStartStream(
    owner: string,
    repo: string,
    jobId: number,
    filter?: string | null
  ): Promise<{ success: boolean; jobId: number }> {
    return this.ipcRenderer.invoke("github-actions:start-stream", owner, repo, jobId, filter ?? undefined);
  }

  /** v3.9: GitHub Actions — stop log stream */
  public async githubActionsStopStream(jobId: number): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("github-actions:stop-stream", jobId);
  }

  /** v3.9: Subscribe to GitHub Actions log stream chunks */
  public onGitHubActionsLogChunk(handler: (payload: { jobId: number; line?: string; error?: string }) => void): () => void {
    const subscription = (_: Electron.IpcRendererEvent, payload: { jobId: number; line?: string; error?: string }) => handler(payload);
    this.ipcRenderer.on("github-actions:log-chunk", subscription);
    return () => this.ipcRenderer.removeListener("github-actions:log-chunk", subscription);
  }

  /** v3.5: Register for chat activity (e.g. summarization). Returns unsubscribe. */
  public onChatActivity(handler: (payload: { label?: string; status?: string; chatId?: number }) => void): () => void {
    this.chatActivityHandlers.add(handler);
    return () => this.chatActivityHandlers.delete(handler);
  }

  /** v3.5: Register for tool start/end events (persistent "Working…" indicator). Returns unsubscribe. */
  public onToolIndicator(
    onStart: (payload: { chatId: number; toolName: string }) => void,
    onEnd: (payload: { chatId: number }) => void,
  ): () => void {
    this.toolStartHandlers.add(onStart);
    this.toolEndHandlers.add(onEnd);
    return () => {
      this.toolStartHandlers.delete(onStart);
      this.toolEndHandlers.delete(onEnd);
    };
  }

  public static getInstance(): IpcClient {
    if (!IpcClient.instance) {
      IpcClient.instance = new IpcClient();
    }
    return IpcClient.instance;
  }

  public async restartAtlarix(): Promise<void> {
    await this.ipcRenderer.invoke("restart-dyad");
  }

  public async reloadEnvPath(): Promise<void> {
    await this.ipcRenderer.invoke("reload-env-path");
  }

  // Create a new app with an initial chat
  public async createApp(params: CreateAppParams): Promise<CreateAppResult> {
    return this.ipcRenderer.invoke("create-app", params);
  }

  // Create chat-only session (no workspace)
  public async createChatOnly(): Promise<{ chatId: number }> {
    const chatId = await this.ipcRenderer.invoke("create-chat-only");
    return { chatId };
  }

  public async getApp(appId: number): Promise<App> {
    return this.ipcRenderer.invoke("get-app", appId);
  }

  public async addAppToFavorite(
    appId: number,
  ): Promise<{ isFavorite: boolean }> {
    try {
      const result = await this.ipcRenderer.invoke("add-to-favorite", {
        appId,
      });
      return result;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  public async getAppEnvVars(
    params: GetAppEnvVarsParams,
  ): Promise<{ key: string; value: string }[]> {
    return this.ipcRenderer.invoke("get-app-env-vars", params);
  }

  public async setAppEnvVars(params: SetAppEnvVarsParams): Promise<void> {
    return this.ipcRenderer.invoke("set-app-env-vars", params);
  }

  public async getChat(chatId: number): Promise<Chat> {
    try {
      const data = await this.ipcRenderer.invoke("get-chat", chatId);
      return data;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Get all chats
  public async getChats(appId?: number): Promise<ChatSummary[]> {
    try {
      const data = await this.ipcRenderer.invoke("get-chats", appId);
      return ChatSummariesSchema.parse(data);
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // search for chats
  public async searchChats(
    appId: number,
    query: string,
  ): Promise<ChatSearchResult[]> {
    try {
      const data = await this.ipcRenderer.invoke("search-chats", appId, query);
      return ChatSearchResultsSchema.parse(data);
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Get all apps
  public async listApps(): Promise<ListAppsResponse> {
    return this.ipcRenderer.invoke("list-apps");
  }

  // Search apps by name
  public async searchApps(searchQuery: string): Promise<AppSearchResult[]> {
    try {
      const data = await this.ipcRenderer.invoke("search-app", searchQuery);
      return AppSearchResultsSchema.parse(data);
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  public async readAppFile(appId: number, filePath: string): Promise<string> {
    return this.ipcRenderer.invoke("read-app-file", {
      appId,
      filePath,
    });
  }

  // Edit a file in an app directory
  public async editAppFile(
    appId: number,
    filePath: string,
    content: string,
  ): Promise<EditAppFileReturnType> {
    return this.ipcRenderer.invoke("edit-app-file", {
      appId,
      filePath,
      content,
    });
  }

  // New method for streaming responses
  public streamMessage(
    prompt: string,
    options: {
      selectedComponents?: ComponentSelection[];
      chatId: number;
      redo?: boolean;
      attachments?: FileAttachment[];
      appId?: number | null;
      modelOverride?: { provider: string; name: string };
      onUpdate: (messages: Message[]) => void;
      onEnd: (response: ChatResponseEnd) => void;
      onError: (error: string) => void;
      onProblems?: (problems: ChatProblemsEvent) => void;
      /** v3.9: Continue after clarifying questions (no new user message; use last user message content). */
      continueAfterQuestions?: boolean;
    },
  ): void {
    const {
      chatId,
      redo,
      attachments,
      selectedComponents,
      appId,
      modelOverride,
      onUpdate,
      onEnd,
      onError,
      continueAfterQuestions,
    } = options;
    this.chatStreams.set(chatId, { onUpdate, onEnd, onError });

    // Handle file attachments if provided
    if (attachments && attachments.length > 0) {
      // Process each file attachment and convert to base64
      Promise.all(
        attachments.map(async (attachment) => {
          return new Promise<{
            name: string;
            type: string;
            data: string;
            attachmentType: "upload-to-codebase" | "chat-context";
          }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              resolve({
                name: attachment.file.name,
                type: attachment.file.type,
                data: reader.result as string,
                attachmentType: attachment.type,
              });
            };
            reader.onerror = () =>
              reject(new Error(`Failed to read file: ${attachment.file.name}`));
            reader.readAsDataURL(attachment.file);
          });
        }),
      )
        .then((fileDataArray) => {
          // Use invoke to start the stream and pass the chatId and attachments
          this.ipcRenderer
            .invoke("chat:stream", {
              prompt,
              chatId,
              redo,
              selectedComponents,
              appId: appId ?? undefined,
              attachments: fileDataArray,
              modelOverride: modelOverride ?? undefined,
              continueAfterQuestions: continueAfterQuestions ?? undefined,
            })
            .catch((err) => {
              console.error("Error streaming message:", err);
              showError(err);
              onError(String(err));
              this.chatStreams.delete(chatId);
            });
        })
        .catch((err) => {
          console.error("Error streaming message:", err);
          showError(err);
          onError(String(err));
          this.chatStreams.delete(chatId);
        });
    } else {
      // No attachments, proceed normally
      this.ipcRenderer
        .invoke("chat:stream", {
          prompt,
          chatId,
          redo,
          selectedComponents,
          appId: appId ?? undefined,
          modelOverride: modelOverride ?? undefined,
          continueAfterQuestions: continueAfterQuestions ?? undefined,
        })
        .catch((err) => {
          console.error("Error streaming message:", err);
          showError(err);
          onError(String(err));
          this.chatStreams.delete(chatId);
        });
    }
  }

  // Method to cancel an ongoing stream (stops AI to save tokens)
  public cancelChatStream(chatId: number): void {
    this.ipcRenderer.invoke("chat:cancel", chatId);
    // Also abort the backend stream to save tokens
    this.ipcRenderer.invoke("chat:abort", chatId);
  }

  // Create a new chat for an app
  public async createChat(appId: number): Promise<number> {
    return this.ipcRenderer.invoke("create-chat", appId);
  }

  public async updateChat(params: UpdateChatParams): Promise<void> {
    return this.ipcRenderer.invoke("update-chat", params);
  }

  public async deleteChat(chatId: number): Promise<void> {
    await this.ipcRenderer.invoke("delete-chat", chatId);
  }

  public async deleteMessages(chatId: number): Promise<void> {
    await this.ipcRenderer.invoke("delete-messages", chatId);
  }

  // Open an external URL using the default browser
  public async openExternalUrl(url: string): Promise<void> {
    await this.ipcRenderer.invoke("open-external-url", url);
  }

  public async getDiscordInviteInfo(): Promise<DiscordInviteInfoResult> {
    return this.ipcRenderer.invoke(
      "discord:get-invite-info",
    ) as Promise<DiscordInviteInfoResult>;
  }

  public async showItemInFolder(fullPath: string): Promise<void> {
    await this.ipcRenderer.invoke("show-item-in-folder", fullPath);
  }

  // Run an app
  public async runApp(
    appId: number,
    onOutput: (output: AppOutput) => void,
  ): Promise<void> {
    await this.ipcRenderer.invoke("run-app", { appId });
    this.appStreams.set(appId, { onOutput });
  }

  // Stop a running app
  public async stopApp(appId: number): Promise<void> {
    await this.ipcRenderer.invoke("stop-app", { appId });
  }

  // Restart a running app
  public async restartApp(
    appId: number,
    onOutput: (output: AppOutput) => void,
    removeNodeModules?: boolean,
  ): Promise<{ success: boolean }> {
    try {
      const result = await this.ipcRenderer.invoke("restart-app", {
        appId,
        removeNodeModules,
      });
      this.appStreams.set(appId, { onOutput });
      return result;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Respond to an app input request (y/n prompts)
  public async respondToAppInput(
    params: RespondToAppInputParams,
  ): Promise<void> {
    try {
      await this.ipcRenderer.invoke("respond-to-app-input", params);
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Get allow-listed environment variables
  public async getEnvVars(): Promise<Record<string, string | undefined>> {
    try {
      const envVars = await this.ipcRenderer.invoke("get-env-vars");
      return envVars as Record<string, string | undefined>;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // List all versions (commits) of an app
  public async listVersions({ appId }: { appId: number }): Promise<Version[]> {
    try {
      const versions = await this.ipcRenderer.invoke("list-versions", {
        appId,
      });
      return versions;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Revert to a specific version
  public async revertVersion(
    params: RevertVersionParams,
  ): Promise<RevertVersionResponse> {
    return this.ipcRenderer.invoke("revert-version", params);
  }

  // Checkout a specific version without creating a revert commit
  public async checkoutVersion({
    appId,
    versionId,
  }: {
    appId: number;
    versionId: string;
  }): Promise<void> {
    await this.ipcRenderer.invoke("checkout-version", {
      appId,
      versionId,
    });
  }

  // Get the current branch of an app
  public async getCurrentBranch(appId: number): Promise<BranchResult> {
    return this.ipcRenderer.invoke("get-current-branch", {
      appId,
    });
  }

  // Get user settings
  public async getUserSettings(): Promise<UserSettings> {
    try {
      const settings = await this.ipcRenderer.invoke("get-user-settings");
      return settings;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Update user settings
  public async setUserSettings(
    settings: Partial<UserSettings>,
  ): Promise<UserSettings> {
    try {
      const updatedSettings = await this.ipcRenderer.invoke(
        "set-user-settings",
        settings,
      );
      return updatedSettings;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  /** v3.6: Get routing preview when Auto is on (category + model for display). */
  public async getRoutingPreview(prompt: string): Promise<{
    category: string;
    targetModel: string;
    targetProvider: string;
  } | null> {
    return this.ipcRenderer.invoke("routing:preview", { prompt });
  }

  // Delete an app and all its files
  public async deleteApp(appId: number): Promise<void> {
    await this.ipcRenderer.invoke("delete-app", { appId });
  }

  // Rename an app (update name and path)
  public async renameApp({
    appId,
    appName,
    appPath,
  }: {
    appId: number;
    appName: string;
    appPath: string;
  }): Promise<void> {
    await this.ipcRenderer.invoke("rename-app", {
      appId,
      appName,
      appPath,
    });
  }

  public async copyApp(params: CopyAppParams): Promise<{ app: App }> {
    return this.ipcRenderer.invoke("copy-app", params);
  }

  // Reset all - removes all app files, settings, and drops the database
  public async resetAll(): Promise<void> {
    await this.ipcRenderer.invoke("reset-all");
  }

  public async addDependency({
    chatId,
    packages,
  }: {
    chatId: number;
    packages: string[];
  }): Promise<void> {
    await this.ipcRenderer.invoke("chat:add-dep", {
      chatId,
      packages,
    });
  }

  // Check Node.js and npm status
  public async getNodejsStatus(): Promise<NodeSystemInfo> {
    return this.ipcRenderer.invoke("nodejs-status");
  }

  // --- GitHub Device Flow ---
  public startGithubDeviceFlow(appId: number | null): void {
    this.ipcRenderer.invoke("github:start-flow", { appId });
  }

  public onGithubDeviceFlowUpdate(
    callback: (data: GitHubDeviceFlowUpdateData) => void,
  ): () => void {
    const listener = (data: any) => {
      console.log("github:flow-update", data);
      callback(data as GitHubDeviceFlowUpdateData);
    };
    this.ipcRenderer.on("github:flow-update", listener);
    // Return a function to remove the listener
    return () => {
      this.ipcRenderer.removeListener("github:flow-update", listener);
    };
  }

  public onGithubDeviceFlowSuccess(
    callback: (data: GitHubDeviceFlowSuccessData) => void,
  ): () => void {
    const listener = (data: any) => {
      console.log("github:flow-success", data);
      callback(data as GitHubDeviceFlowSuccessData);
    };
    this.ipcRenderer.on("github:flow-success", listener);
    return () => {
      this.ipcRenderer.removeListener("github:flow-success", listener);
    };
  }

  public onGithubDeviceFlowError(
    callback: (data: GitHubDeviceFlowErrorData) => void,
  ): () => void {
    const listener = (data: any) => {
      console.log("github:flow-error", data);
      callback(data as GitHubDeviceFlowErrorData);
    };
    this.ipcRenderer.on("github:flow-error", listener);
    return () => {
      this.ipcRenderer.removeListener("github:flow-error", listener);
    };
  }
  // --- End GitHub Device Flow ---

  // --- GitHub Repo Management ---
  public async listGithubRepos(): Promise<
    { name: string; full_name: string; private: boolean }[]
  > {
    return this.ipcRenderer.invoke("github:list-repos");
  }

  public async getGithubRepoBranches(
    owner: string,
    repo: string,
  ): Promise<{ name: string; commit: { sha: string } }[]> {
    return this.ipcRenderer.invoke("github:get-repo-branches", {
      owner,
      repo,
    });
  }

  public async connectToExistingGithubRepo(
    owner: string,
    repo: string,
    branch: string,
    appId: number,
  ): Promise<void> {
    await this.ipcRenderer.invoke("github:connect-existing-repo", {
      owner,
      repo,
      branch,
      appId,
    });
  }

  public async checkGithubRepoAvailable(
    org: string,
    repo: string,
  ): Promise<{ available: boolean; error?: string }> {
    return this.ipcRenderer.invoke("github:is-repo-available", {
      org,
      repo,
    });
  }

  public async createGithubRepo(
    org: string,
    repo: string,
    appId: number,
    branch?: string,
  ): Promise<void> {
    await this.ipcRenderer.invoke("github:create-repo", {
      org,
      repo,
      appId,
      branch,
    });
  }

  // Sync (push) local repo to GitHub
  public async syncGithubRepo(
    appId: number,
    force?: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    return this.ipcRenderer.invoke("github:push", {
      appId,
      force,
    });
  }

  public async disconnectGithubRepo(appId: number): Promise<void> {
    await this.ipcRenderer.invoke("github:disconnect", {
      appId,
    });
  }
  // --- End GitHub Repo Management ---

  // --- Vercel Token Management ---
  public async saveVercelAccessToken(
    params: SaveVercelAccessTokenParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("vercel:save-token", params);
  }
  // --- End Vercel Token Management ---

  // --- Vercel Project Management ---
  public async listVercelProjects(): Promise<VercelProject[]> {
    return this.ipcRenderer.invoke("vercel:list-projects", undefined);
  }

  public async connectToExistingVercelProject(
    params: ConnectToExistingVercelProjectParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("vercel:connect-existing-project", params);
  }

  public async isVercelProjectAvailable(
    params: IsVercelProjectAvailableParams,
  ): Promise<IsVercelProjectAvailableResponse> {
    return this.ipcRenderer.invoke("vercel:is-project-available", params);
  }

  public async createVercelProject(
    params: CreateVercelProjectParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("vercel:create-project", params);
  }

  // Get Vercel Deployments
  public async getVercelDeployments(
    params: GetVercelDeploymentsParams,
  ): Promise<VercelDeployment[]> {
    return this.ipcRenderer.invoke("vercel:get-deployments", params);
  }

  public async disconnectVercelProject(
    params: DisconnectVercelProjectParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("vercel:disconnect", params);
  }
  // --- End Vercel Project Management ---

  // Get the main app version
  public async getAppVersion(): Promise<string> {
    const result = await this.ipcRenderer.invoke("get-app-version");
    return result.version as string;
  }

  /** Get Sentry config (DSN, version, isPackaged) for renderer init and dev test shortcut. */
  public async getSentryConfig(): Promise<{
    dsn: string | undefined;
    version: string;
    isPackaged: boolean;
  }> {
    return this.ipcRenderer.invoke("get-sentry-config");
  }

  /** Get PostHog config (API key + anonymous ID) for renderer init. Key undefined if not set. */
  public async getPostHogConfig(): Promise<{
    posthogApiKey: string | undefined;
    analyticsId: string;
  }> {
    return this.ipcRenderer.invoke("get-posthog-config");
  }

  /** Whether the main process has initialized the database (for loading gate). */
  public async getDbReady(): Promise<boolean> {
    return this.ipcRenderer.invoke("get-db-ready");
  }

  // --- MCP Client Methods ---
  public async listMcpServers(filter?: { scope?: "global" | "workspace" | "globalAndWorkspace"; appId?: number }) {
    return this.ipcRenderer.invoke("mcp:list-servers", filter);
  }

  public async createMcpServer(params: CreateMcpServer) {
    return this.ipcRenderer.invoke("mcp:create-server", params);
  }

  public async updateMcpServer(params: McpServerUpdate) {
    return this.ipcRenderer.invoke("mcp:update-server", params);
  }

  public async deleteMcpServer(id: number) {
    return this.ipcRenderer.invoke("mcp:delete-server", id);
  }

  public async listMcpTools(serverId: number) {
    return this.ipcRenderer.invoke("mcp:list-tools", serverId);
  }

  public async testMcpConnection(
    serverId: number,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.ipcRenderer.invoke("mcp:test-connection", serverId);
  }

  // Removed: upsertMcpTools and setMcpToolActive – tools are fetched dynamically at runtime

  public async getMcpToolConsents() {
    return this.ipcRenderer.invoke("mcp:get-tool-consents");
  }

  public async setMcpToolConsent(params: {
    serverId: number;
    toolName: string;
    consent: "ask" | "always" | "denied";
  }) {
    return this.ipcRenderer.invoke("mcp:set-tool-consent", params);
  }

  public onMcpToolConsentRequest(
    handler: (payload: {
      requestId: string;
      serverId: number;
      serverName: string;
      toolName: string;
      toolDescription?: string | null;
      inputPreview?: string | null;
    }) => void,
  ) {
    this.mcpConsentHandlers.set("consent", handler as any);
    return () => {
      this.mcpConsentHandlers.delete("consent");
    };
  }

  public respondToMcpConsentRequest(
    requestId: string,
    decision: "accept-once" | "accept-always" | "decline",
  ) {
    this.ipcRenderer.invoke("mcp:tool-consent-response", {
      requestId,
      decision,
    });
  }

  // Get proposal details
  public async getProposal(chatId: number): Promise<ProposalResult | null> {
    try {
      const data = await this.ipcRenderer.invoke("get-proposal", { chatId });
      // Assuming the main process returns data matching the ProposalResult interface
      // Add a type check/guard if necessary for robustness
      return data as ProposalResult | null;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Example methods for listening to events (if needed)
  // public on(channel: string, func: (...args: any[]) => void): void {

  // --- Proposal Management ---
  public async approveProposal({
    chatId,
    messageId,
  }: {
    chatId: number;
    messageId: number;
  }): Promise<ApproveProposalResult> {
    return this.ipcRenderer.invoke("approve-proposal", {
      chatId,
      messageId,
    });
  }

  public async rejectProposal({
    chatId,
    messageId,
  }: {
    chatId: number;
    messageId: number;
  }): Promise<void> {
    await this.ipcRenderer.invoke("reject-proposal", {
      chatId,
      messageId,
    });
  }
  // --- End Proposal Management ---

  // --- Permission Management (New Tool-based Permissions) ---
  public async executePermission({
    chatId,
    operationId,
  }: {
    chatId: number;
    operationId: string;
  }): Promise<{ operationId: string; approved: boolean; executedAt?: number; error?: string }> {
    return this.ipcRenderer.invoke("execute-permission", {
      chatId,
      operationId,
    });
  }

  public async rejectPermission({
    chatId,
    operationId,
  }: {
    chatId: number;
    operationId: string;
  }): Promise<{ operationId: string; approved: boolean; error?: string }> {
    return this.ipcRenderer.invoke("reject-permission", {
      chatId,
      operationId,
    });
  }

  public async executeAllPermissions({
    chatId,
  }: {
    chatId: number;
  }): Promise<Array<{ operationId: string; approved: boolean; executedAt?: number; error?: string }>> {
    return this.ipcRenderer.invoke("execute-all-permissions", {
      chatId,
    });
  }

  public async rejectAllPermissions({
    chatId,
  }: {
    chatId: number;
  }): Promise<Array<{ operationId: string; approved: boolean; error?: string }>> {
    return this.ipcRenderer.invoke("reject-all-permissions", {
      chatId,
    });
  }

  public async getPendingPermissions({
    chatId,
  }: {
    chatId: number;
  }): Promise<Array<{ id: string; request: any }>> {
    return this.ipcRenderer.invoke("get-pending-permissions", {
      chatId,
    });
  }

  /**
   * Register a handler for mode change request (Ask -> Build approval).
   * Returns unsubscribe function.
   */
  public onModeChangeRequest(
    handler: (payload: { chatId: number; requestedMode: string; reason: string }) => void
  ): () => void {
    this.modeChangeHandler = handler;
    return () => {
      this.modeChangeHandler = null;
    };
  }

  /**
   * Respond to a mode change request (approve or deny).
   */
  public async respondModeChange(chatId: number, approve: boolean): Promise<{ ok: boolean }> {
    return this.ipcRenderer.invoke("respond-mode-change", { chatId, approve });
  }

  /**
   * Register a handler for permission request events for a specific chat
   * Returns unsubscribe function
   */
  public onPermissionRequest(
    chatId: number,
    handler: (payload: {
      chatId: number;
      type: "permission-request";
      operationId: string;
      request: any;
    }) => void
  ): () => void {
    this.permissionHandlers.set(chatId, handler);
    return () => {
      this.permissionHandlers.delete(chatId);
    };
  }

  /**
   * Register a handler for workspace diagram events for a specific chat
   * Returns unsubscribe function
   */
  public onWorkspaceDiagram(
    chatId: number,
    handler: (payload: {
      chatId: number;
      type: string;
      title: string;
      mermaidCode: string;
      snapshotId: number;
    }) => void
  ): () => void {
    this.diagramHandlers.set(chatId, handler);
    return () => {
      this.diagramHandlers.delete(chatId);
    };
  }

  /**
   * Register a handler for terminal output events for a specific chat
   * Returns unsubscribe function
   */
  public onTerminalOutput(
    chatId: number,
    handler: (payload: {
      chatId: number;
      commandId: string;
      command: string;
      output: string;
      status: 'running' | 'completed' | 'error';
      exitCode?: number;
      isPermissionBased?: boolean; // True if this command came from permission system
    }) => void
  ): () => void {
    this.terminalHandlers.set(chatId, handler);
    return () => {
      this.terminalHandlers.delete(chatId);
    };
  }

  /**
   * Register a handler for dev server output events
   * Receives streaming output from auto-started dev servers
   * Returns unsubscribe function
   */
  public onDevServerOutput(
    handler: (payload: {
      workspaceId: number;
      framework: string;
      output: string;
      fullOutput: string;
      status: 'running' | 'stopped' | 'error';
      timestamp: number;
    }) => void
  ): () => void {
    const listener = (data: any) => handler(data);
    this.ipcRenderer.on('dev-server:output', listener);
    return () => {
      this.ipcRenderer.removeListener('dev-server:output', listener);
    };
  }

  /**
   * Register a handler for operation status updates (permission queue)
   * Returns unsubscribe function
   */
  public onOperationStatus(
    handler: (payload: {
      operationId: string;
      status: 'pending' | 'queued' | 'running' | 'completed' | 'failed';
      progress?: number;
      duration?: number;
      error?: string;
    }) => void
  ): () => void {
    const listener = (data: any) => handler(data);
    this.ipcRenderer.on('operation-status', listener);
    return () => {
      this.ipcRenderer.removeListener('operation-status', listener);
    };
  }

  /**
   * Register a handler for auto-recovery events
   * Fires when command(s) fail and AI should analyze
   */
  public onAutoRecovery(
    handler: (payload: {
      chatId: number;
      prompt: string;
      failureCount: number;
    }) => void
  ): () => void {
    const listener = (data: any) => handler(data);
    this.ipcRenderer.on('auto-recovery-needed', listener);
    return () => {
      this.ipcRenderer.removeListener('auto-recovery-needed', listener);
    };
  }
  // --- End Permission Management ---

  // --- Supabase Management ---
  public async listSupabaseProjects(): Promise<any[]> {
    return this.ipcRenderer.invoke("supabase:list-projects");
  }

  public async listSupabaseBranches(params: {
    projectId: string;
  }): Promise<SupabaseBranch[]> {
    return this.ipcRenderer.invoke("supabase:list-branches", params);
  }

  public async setSupabaseAppProject(
    params: SetSupabaseAppProjectParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("supabase:set-app-project", params);
  }

  public async unsetSupabaseAppProject(app: number): Promise<void> {
    await this.ipcRenderer.invoke("supabase:unset-app-project", {
      app,
    });
  }

  public async fakeHandleSupabaseConnect(params: {
    appId: number;
    fakeProjectId: string;
  }): Promise<void> {
    await this.ipcRenderer.invoke(
      "supabase:fake-connect-and-set-project",
      params,
    );
  }

  // --- End Supabase Management ---

  // --- Neon Management ---
  public async fakeHandleNeonConnect(): Promise<void> {
    await this.ipcRenderer.invoke("neon:fake-connect");
  }

  public async createNeonProject(
    params: CreateNeonProjectParams,
  ): Promise<NeonProject> {
    return this.ipcRenderer.invoke("neon:create-project", params);
  }

  public async getNeonProject(
    params: GetNeonProjectParams,
  ): Promise<GetNeonProjectResponse> {
    return this.ipcRenderer.invoke("neon:get-project", params);
  }

  // --- End Neon Management ---

  // --- Portal Management ---
  public async portalMigrateCreate(params: {
    appId: number;
  }): Promise<{ output: string }> {
    return this.ipcRenderer.invoke("portal:migrate-create", params);
  }

  // --- End Portal Management ---

  public async getSystemDebugInfo(): Promise<SystemDebugInfo> {
    return this.ipcRenderer.invoke("get-system-debug-info");
  }

  public async getChatLogs(chatId: number): Promise<ChatLogsData> {
    return this.ipcRenderer.invoke("get-chat-logs", chatId);
  }

  public async uploadToSignedUrl(
    url: string,
    contentType: string,
    data: any,
  ): Promise<void> {
    await this.ipcRenderer.invoke("upload-to-signed-url", {
      url,
      contentType,
      data,
    });
  }

  public async listLocalOllamaModels(): Promise<LocalModel[]> {
    const response = await this.ipcRenderer.invoke("local-models:list-ollama");
    return response?.models || [];
  }

  public async listLocalLMStudioModels(): Promise<LocalModelListResponse> {
    const response = await this.ipcRenderer.invoke(
      "local-models:list-lmstudio",
    );
    return response;
  }

  // Listen for deep link events
  public onDeepLinkReceived(
    callback: (data: DeepLinkData) => void,
  ): () => void {
    const listener = (data: any) => {
      callback(data as DeepLinkData);
    };
    this.ipcRenderer.on("deep-link-received", listener);
    return () => {
      this.ipcRenderer.removeListener("deep-link-received", listener);
    };
  }

  // Listen for force close detected events
  public onForceCloseDetected(
    callback: (data: {
      performanceData?: {
        timestamp: number;
        memoryUsageMB: number;
        cpuUsagePercent?: number;
        systemMemoryUsageMB?: number;
        systemMemoryTotalMB?: number;
        systemCpuPercent?: number;
      };
    }) => void,
  ): () => void {
    const listener = (data: any) => {
      callback(data);
    };
    this.ipcRenderer.on("force-close-detected", listener);
    return () => {
      this.ipcRenderer.removeListener("force-close-detected", listener);
    };
  }

  /** Subscribe to db-ready event (main process has initialized the database). Returns unsubscribe. */
  public onDbReady(callback: () => void): () => void {
    this.ipcRenderer.on("db-ready", callback);
    return () => {
      this.ipcRenderer.removeListener("db-ready", callback);
    };
  }

  // Listen for diagram staleness detected events
  // Fired when project changes significantly (50%+) and diagram needs refresh
  public onDiagramStalenessDetected(
    callback: (data: {
      diagramId: number;
      isStale: boolean;
      severity: 'minor' | 'moderate' | 'major';
      reason: string;
      recommendation: 'keep' | 'suggest-refresh' | 'force-refresh';
    }) => void,
  ): () => void {
    const listener = (data: any) => {
      callback(data);
    };
    this.ipcRenderer.on("diagram:staleness-detected", listener);
    return () => {
      this.ipcRenderer.removeListener("diagram:staleness-detected", listener);
    };
  }

  // Count tokens for a chat and input
  public async countTokens(
    params: TokenCountParams,
  ): Promise<TokenCountResult> {
    try {
      const result = await this.ipcRenderer.invoke("chat:count-tokens", params);
      return result as TokenCountResult;
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Window control methods
  public async minimizeWindow(): Promise<void> {
    try {
      await this.ipcRenderer.invoke("window:minimize");
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  public async maximizeWindow(): Promise<void> {
    try {
      await this.ipcRenderer.invoke("window:maximize");
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  public async closeWindow(): Promise<void> {
    try {
      await this.ipcRenderer.invoke("window:close");
    } catch (error) {
      showError(error);
      throw error;
    }
  }

  // Get system platform (win32, darwin, linux)
  public async getSystemPlatform(): Promise<string> {
    return this.ipcRenderer.invoke("get-system-platform");
  }

  public async doesReleaseNoteExist(
    params: DoesReleaseNoteExistParams,
  ): Promise<{ exists: boolean; url?: string }> {
    return this.ipcRenderer.invoke("does-release-note-exist", params);
  }

  public async getLanguageModelProviders(): Promise<LanguageModelProvider[]> {
    return this.ipcRenderer.invoke("get-language-model-providers");
  }

  public async getLanguageModels(params: {
    providerId: string;
  }): Promise<LanguageModel[]> {
    return this.ipcRenderer.invoke("get-language-models", params);
  }

  public async getLanguageModelsByProviders(): Promise<
    Record<string, LanguageModel[]>
  > {
    return this.ipcRenderer.invoke("get-language-models-by-providers");
  }

  /** Refresh model catalog from models.dev (OpenCode-style dynamic models) */
  public async refreshModelsDev(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("models-dev:refresh");
  }

  /** Search codebase with natural language (semantic search) */
  public async searchCodebase(params: {
    query: string;
    appId: number;
    maxResults?: number;
  }): Promise<{
    success: boolean;
    query?: string;
    results?: any[];
    formatted_with_context?: string;
    total_matches?: number;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("search-codebase", params);
  }

  public async createCustomLanguageModelProvider({
    id,
    name,
    apiBaseUrl,
    envVarName,
  }: CreateCustomLanguageModelProviderParams): Promise<LanguageModelProvider> {
    return this.ipcRenderer.invoke("create-custom-language-model-provider", {
      id,
      name,
      apiBaseUrl,
      envVarName,
    });
  }
  public async editCustomLanguageModelProvider(
    params: CreateCustomLanguageModelProviderParams,
  ): Promise<LanguageModelProvider> {
    return this.ipcRenderer.invoke(
      "edit-custom-language-model-provider",
      params,
    );
  }

  public async createCustomLanguageModel(
    params: CreateCustomLanguageModelParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("create-custom-language-model", params);
  }

  public async deleteCustomLanguageModel(modelId: string): Promise<void> {
    return this.ipcRenderer.invoke("delete-custom-language-model", modelId);
  }

  async deleteCustomModel(params: DeleteCustomModelParams): Promise<void> {
    return this.ipcRenderer.invoke("delete-custom-model", params);
  }

  async deleteCustomLanguageModelProvider(providerId: string): Promise<void> {
    return this.ipcRenderer.invoke("delete-custom-language-model-provider", {
      providerId,
    });
  }

  public async selectAppFolder(): Promise<{
    path: string | null;
    name: string | null;
  }> {
    return this.ipcRenderer.invoke("select-app-folder");
  }

  // Add these methods to IpcClient class

  public async selectNodeFolder(): Promise<SelectNodeFolderResult> {
    return this.ipcRenderer.invoke("select-node-folder");
  }

  public async getNodePath(): Promise<string | null> {
    return this.ipcRenderer.invoke("get-node-path");
  }

  public async checkAiRules(params: {
    path: string;
  }): Promise<{ exists: boolean }> {
    return this.ipcRenderer.invoke("check-ai-rules", params);
  }

  public async getLatestSecurityReview(
    appId: number,
  ): Promise<SecurityReviewResult> {
    return this.ipcRenderer.invoke("get-latest-security-review", appId);
  }

  public async importApp(params: ImportAppParams): Promise<ImportAppResult> {
    return this.ipcRenderer.invoke("import-app", params);
  }

  async checkAppName(params: {
    appName: string;
  }): Promise<{ exists: boolean }> {
    return this.ipcRenderer.invoke("check-app-name", params);
  }

  public async renameBranch(params: RenameBranchParams): Promise<void> {
    await this.ipcRenderer.invoke("rename-branch", params);
  }

  async clearSessionData(): Promise<void> {
    return this.ipcRenderer.invoke("clear-session-data");
  }

  // Method to get user budget information
  public async getUserBudget(): Promise<UserBudgetInfo | null> {
    return this.ipcRenderer.invoke("get-user-budget");
  }

  public async getChatContextResults(params: {
    appId: number;
  }): Promise<ContextPathResults> {
    return this.ipcRenderer.invoke("get-context-paths", params);
  }

  public async setChatContext(params: {
    appId: number;
    chatContext: AppChatContext;
  }): Promise<void> {
    await this.ipcRenderer.invoke("set-context-paths", params);
  }

  public async getAppUpgrades(params: {
    appId: number;
  }): Promise<AppUpgrade[]> {
    return this.ipcRenderer.invoke("get-app-upgrades", params);
  }

  public async executeAppUpgrade(params: {
    appId: number;
    upgradeId: string;
  }): Promise<void> {
    return this.ipcRenderer.invoke("execute-app-upgrade", params);
  }

  // Capacitor methods
  public async isCapacitor(params: { appId: number }): Promise<boolean> {
    return this.ipcRenderer.invoke("is-capacitor", params);
  }

  public async syncCapacitor(params: { appId: number }): Promise<void> {
    return this.ipcRenderer.invoke("sync-capacitor", params);
  }

  public async openIos(params: { appId: number }): Promise<void> {
    return this.ipcRenderer.invoke("open-ios", params);
  }

  public async openAndroid(params: { appId: number }): Promise<void> {
    return this.ipcRenderer.invoke("open-android", params);
  }

  public async checkProblems(params: {
    appId: number;
  }): Promise<ProblemReport> {
    return this.ipcRenderer.invoke("check-problems", params);
  }

  // Template methods
  public async getTemplates(): Promise<Template[]> {
    return this.ipcRenderer.invoke("get-templates");
  }

  /**
   * Get all available templates (local + API + GitHub)
   * Returns templates ranked by quality score
   */
  async listTemplates(): Promise<Template[]> {
    return this.ipcRenderer.invoke("list-templates");
  }

  // ═══════════════════════════════════════════════════════════
  // PROMPTS - Global + Workspace System
  // ═══════════════════════════════════════════════════════════

  /**
   * Get the global prompt (or null if none exists)
   */
  public async getGlobalPrompt(): Promise<{
    id: number;
    type: "global" | "workspace";
    workspaceId: number | null;
    content: string;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.ipcRenderer.invoke("prompts:get-global");
  }

  /**
   * Set/update the global prompt (replaces existing)
   */
  public async setGlobalPrompt(content: string): Promise<{
    id: number;
    type: "global" | "workspace";
    workspaceId: number | null;
    content: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.ipcRenderer.invoke("prompts:set-global", { content });
  }

  /**
   * Delete the global prompt
   */
  public async deleteGlobalPrompt(): Promise<void> {
    await this.ipcRenderer.invoke("prompts:delete-global");
  }

  /**
   * Get workspace prompt (or null if none exists)
   */
  public async getWorkspacePrompt(workspaceId: number): Promise<{
    id: number;
    type: "global" | "workspace";
    workspaceId: number | null;
    content: string;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.ipcRenderer.invoke("prompts:get-workspace", workspaceId);
  }

  /**
   * Set/update workspace prompt (replaces existing)
   */
  public async setWorkspacePrompt(workspaceId: number, content: string): Promise<{
    id: number;
    type: "global" | "workspace";
    workspaceId: number | null;
    content: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.ipcRenderer.invoke("prompts:set-workspace", { workspaceId, content });
  }

  /**
   * Delete workspace prompt
   */
  public async deleteWorkspacePrompt(workspaceId: number): Promise<void> {
    await this.ipcRenderer.invoke("prompts:delete-workspace", workspaceId);
  }

  /**
   * Delete any prompt by ID
   */
  public async deletePrompt(id: number): Promise<void> {
    await this.ipcRenderer.invoke("prompts:delete", id);
  }

  /**
   * List all workspaces with their prompt status
   * Used by Library page
   */
  public async listWorkspacesWithPromptStatus(): Promise<{
    id: number;
    name: string;
    path: string;
    hasPrompt: boolean;
    promptContent?: string;
  }[]> {
    return this.ipcRenderer.invoke("prompts:list-workspaces-with-status");
  }

  // Legacy methods (deprecated)
  public async listPrompts(): Promise<any[]> {
    console.warn("listPrompts is deprecated, use getGlobalPrompt or getWorkspacePrompt");
    return this.ipcRenderer.invoke("prompts:list");
  }

  public async createPrompt(params: CreatePromptParamsDto): Promise<any> {
    console.warn("createPrompt is deprecated, use setGlobalPrompt or setWorkspacePrompt");
    return this.ipcRenderer.invoke("prompts:create", params);
  }

  public async updatePrompt(params: UpdatePromptParamsDto): Promise<void> {
    console.warn("updatePrompt is deprecated, use setGlobalPrompt or setWorkspacePrompt");
    await this.ipcRenderer.invoke("prompts:update", params);
  }
  public async cloneRepoFromUrl(
    params: CloneRepoParams,
  ): Promise<{ app: App; hasAiRules: boolean } | { error: string }> {
    return this.ipcRenderer.invoke("github:clone-repo-from-url", params);
  }

  // --- Help bot ---
  public startHelpChat(
    sessionId: string,
    message: string,
    options: {
      onChunk: (delta: string) => void;
      onEnd: () => void;
      onError: (error: string) => void;
    },
  ): void {
    this.helpStreams.set(sessionId, options);
    this.ipcRenderer
      .invoke("help:chat:start", { sessionId, message })
      .catch((err) => {
        this.helpStreams.delete(sessionId);
        showError(err);
        options.onError(String(err));
      });
  }

  public async takeScreenshot(): Promise<void> {
    await this.ipcRenderer.invoke("take-screenshot");
  }

  public cancelHelpChat(sessionId: string): void {
    this.ipcRenderer.invoke("help:chat:cancel", sessionId).catch(() => { });
  }

  // --- Visual Editing ---
  public async applyVisualEditingChanges(
    changes: ApplyVisualEditingChangesParams,
  ): Promise<void> {
    await this.ipcRenderer.invoke("apply-visual-editing-changes", changes);
  }

  public async analyzeComponent(
    params: AnalyseComponentParams,
  ): Promise<{ isDynamic: boolean; hasStaticText: boolean }> {
    return this.ipcRenderer.invoke("analyze-component", params);
  }

  // Provider API Key Management
  public async getProviderApiKey(providerId: string): Promise<string | undefined> {
    return this.ipcRenderer.invoke("provider:get-api-key", { providerId });
  }

  public async setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
    return this.ipcRenderer.invoke("provider:set-api-key", { providerId, apiKey });
  }

  public async deleteProviderApiKey(providerId: string): Promise<void> {
    return this.ipcRenderer.invoke("provider:delete-api-key", { providerId });
  }

  public async getConfiguredProviders(): Promise<string[]> {
    return this.ipcRenderer.invoke("provider:get-configured");
  }

  // OpenRouter Favorites Management
  public async getFavoriteOpenRouterModels(): Promise<string[]> {
    return this.ipcRenderer.invoke("openrouter:get-favorites");
  }

  public async setFavoriteOpenRouterModels(modelIds: string[]): Promise<void> {
    return this.ipcRenderer.invoke("openrouter:set-favorites", { modelIds });
  }

  public async addFavoriteOpenRouterModel(modelId: string): Promise<void> {
    return this.ipcRenderer.invoke("openrouter:add-favorite", { modelId });
  }

  public async removeFavoriteOpenRouterModel(modelId: string): Promise<void> {
    return this.ipcRenderer.invoke("openrouter:remove-favorite", { modelId });
  }

  public async isOpenRouterModelFavorited(modelId: string): Promise<boolean> {
    return this.ipcRenderer.invoke("openrouter:is-favorited", { modelId });
  }

  // SearxNG search methods
  public async checkSearxngHealth(url: string): Promise<{ success: boolean; error?: string; resultsCount?: number }> {
    return this.ipcRenderer.invoke("searxng:health-check", url);
  }

  public async searchSearxng(params: {
    url: string;
    query: string;
    options?: {
      categories?: string[];
      engines?: string[];
      language?: string;
      pageno?: number;
    };
  }): Promise<{ success: boolean; results?: any[]; suggestions?: string[]; error?: string }> {
    return this.ipcRenderer.invoke("searxng:search", params);
  }

  // Sync SearxNG config from renderer localStorage to main process
  public async syncSearxngConfig(config: { url: string | null; enabled: boolean }): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("searxng:set-config", config);
  }

  // Get SearxNG config from database (via main process)
  public async getSearxngConfig(): Promise<{ url: string | null; enabled: boolean }> {
    return this.ipcRenderer.invoke("searxng:get-config");
  }

  // Delete SearxNG config
  public async deleteSearxngConfig(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("searxng:delete-config");
  }

  // ============================================
  // DIAGRAM METHODS
  // ============================================

  public async generateDiagram(input: {
    workspaceId?: number;
    chatId?: number;
    type: "mermaid" | "architecture" | "sequence" | "class" | "flowchart";
    title: string;
    content: string;
    metadata?: { files?: string[]; entities?: string[]; focus?: string };
  }): Promise<{ success: boolean; diagram?: any; error?: string }> {
    return this.ipcRenderer.invoke("diagram:generate", input);
  }

  public async generateAiDiagram(input: {
    workspaceId: number;
    title?: string;
  }): Promise<{ success: boolean; diagram?: any; error?: string }> {
    return this.ipcRenderer.invoke("diagram:generate-ai", input);
  }

  public async listDiagrams(params: { workspaceId?: number }): Promise<{
    success: boolean;
    diagrams: any[];
    error?: string;
  }> {
    return this.ipcRenderer.invoke("diagram:list", params);
  }

  public async getDiagram(id: number): Promise<{
    success: boolean;
    diagram?: any;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("diagram:get", { id });
  }

  public async updateDiagram(params: {
    id: number;
    content: string;
    changeDescription?: string;
  }): Promise<{ success: boolean; diagram?: any; error?: string }> {
    return this.ipcRenderer.invoke("diagram:update", params);
  }

  public async deleteDiagram(id: number): Promise<{ success: boolean; error?: string }> {
    return this.ipcRenderer.invoke("diagram:delete", { id });
  }

  public async getDiagramHistory(diagramId: number): Promise<{
    success: boolean;
    versions: any[];
    error?: string;
  }> {
    return this.ipcRenderer.invoke("diagram:history", { diagramId });
  }

  /** Storage-based diagram history from internal git (real dates, for previous diagrams / AI comparison). */
  public async getDiagramHistoryFromGit(params: {
    workspaceId: number;
    maxCount?: number;
  }): Promise<{
    success: boolean;
    versions: Array<{ commit: string; date: string; message: string; content?: string }>;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("diagram:history-from-git", params);
  }

  public async restoreDiagramVersion(params: {
    diagramId: number;
    versionId: number;
  }): Promise<{ success: boolean; diagram?: any; error?: string }> {
    return this.ipcRenderer.invoke("diagram:restore", params);
  }

  public async exportDiagram(params: {
    id: number;
    format: "svg" | "png" | "code";
  }): Promise<{ success: boolean; data?: string; error?: string }> {
    return this.ipcRenderer.invoke("diagram:export", params);
  }

  public async checkDiagramStaleness(params: {
    diagramId: number;
    workspacePath: string;
  }): Promise<{
    success: boolean;
    staleness?: {
      isStale: boolean;
      severity: 'none' | 'minor' | 'moderate' | 'major';
      reason: string;
      changes: {
        filesAdded: number;
        filesRemoved: number;
        fileCountChange: number;
        percentChange: number;
      };
      recommendation: 'keep' | 'suggest-refresh' | 'force-refresh';
    };
    /** When workspace is git: update vs regenerate decision */
    gitDecision?: {
      action: 'none' | 'update' | 'regenerate';
      reason: string;
      confidence: number;
      totalFiles: number;
      linesAdded: number;
      linesDeleted: number;
    };
    error?: string;
  }> {
    return this.ipcRenderer.invoke("diagram:check-staleness", params);
  }

  /** Mark diagram as stale (e.g. after workflow codegen) so user sees refresh banner */
  public async markDiagramStale(params: { workspaceId: number }): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("diagram:mark-stale", params);
  }

  // --- Blueprint (Phase 7 Additive Blueprint) ---
  public async getBlueprint(params: { workspaceId: number }): Promise<{
    success: boolean;
    blueprint?: import("@/shared/blueprint-types").Blueprint;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("blueprint:get", params);
  }

  public async setBlueprint(params: {
    workspaceId: number;
    blueprint: import("@/shared/blueprint-types").Blueprint;
  }): Promise<{ success: boolean; error?: string }> {
    return this.ipcRenderer.invoke("blueprint:set", params);
  }

  /** v3.6: Get reference project paths for combined blueprint */
  public async getReferencePaths(workspaceId: number): Promise<{ success: boolean; paths?: string[]; error?: string }> {
    return this.ipcRenderer.invoke("blueprint:get-reference-paths", { workspaceId });
  }

  /** v3.6: Set reference project paths for combined blueprint */
  public async setReferencePaths(workspaceId: number, paths: string[]): Promise<{ success: boolean; error?: string }> {
    return this.ipcRenderer.invoke("blueprint:set-reference-paths", { workspaceId, paths });
  }

  /** Refresh blueprint from code (invalidate cache, re-infer from workspace) */
  public async refreshBlueprintFromCode(params: { workspaceId: number }): Promise<{
    success: boolean;
    blueprint?: import("@/shared/blueprint-types").Blueprint;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("blueprint:refresh-from-code", params);
  }

  /** Analyze workspace for blueprint: list projects with activity and recommendation */
  public async analyzeWorkspaceForBlueprint(params: { workspaceId: number }): Promise<{
    success: boolean;
    projects?: import("@/lib/blueprint/project-selector").ProjectCandidate[];
    error?: string;
  }> {
    return this.ipcRenderer.invoke("blueprint:analyze-workspace", params);
  }

  /** Generate combined blueprint from selected project IDs; sets single-project blueprint when one selected */
  public async generateCombinedBlueprint(params: {
    workspaceId: number;
    projectIds: string[];
  }): Promise<{
    success: boolean;
    combined?: import("@/shared/blueprint-types").CombinedBlueprint;
    blueprint?: import("@/shared/blueprint-types").Blueprint;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("blueprint:generate-combined", params);
  }

  /** Simplify beacon description with AI (fast model); updates blueprint and emits blueprint:updated */
  public async simplifyBlueprintDescription(params: {
    workspaceId: number;
    roomId: string;
    functionId: string;
  }): Promise<{ success: boolean; simpleDescription?: string; error?: string }> {
    return this.ipcRenderer.invoke("blueprint:simplify-description", params);
  }

  public async simplifyBlueprintRoom(params: {
    workspaceId: number;
    roomId: string;
  }): Promise<{ success: boolean; label?: string; intent?: string; error?: string }> {
    return this.ipcRenderer.invoke("blueprint:simplify-room", params);
  }

  public async simplifyBlueprintArchitecture(params: {
    workspaceId: number;
  }): Promise<{ success: boolean; summary?: string; error?: string }> {
    return this.ipcRenderer.invoke("blueprint:simplify-architecture", params);
  }

  /** Layout container canvas via ELK (main process) */
  public async layoutContainerCanvas(
    rooms: Array<{ id: string }>,
    edges: Array<{ id: string; from: string; to: string }>
  ): Promise<Array<{ id: string; x: number; y: number; width: number; height: number }>> {
    return this.ipcRenderer.invoke("blueprint:layout-containers", { rooms, edges });
  }

  /** Layout beacon flow inside a room via ELK (main process) */
  public async layoutBeaconFlow(
    beacons: Array<{ id: string }>,
    flowEdges: Array<{ id: string; from: string; to: string }>
  ): Promise<Array<{ id: string; x: number; y: number; width: number; height: number }>> {
    return this.ipcRenderer.invoke("blueprint:layout-beacons", { beacons, flowEdges });
  }

  /** DB Extension: list connections and active id for workspace */
  public async dbListConnections(workspaceId: number | null): Promise<{
    connections: Array<{ id: string; name: string; type: string; status: string; isProd?: boolean }>;
    activeId: string | null;
  }> {
    return this.ipcRenderer.invoke("db:list-connections", { workspaceId });
  }

  /** DB Extension: save a new connection */
  public async dbSaveConnection(params: {
    name: string;
    type: string;
    config: Record<string, unknown>;
    isProd?: boolean;
  }): Promise<{ id: string; success: boolean }> {
    return this.ipcRenderer.invoke("db:save-connection", params);
  }

  /** DB Extension: delete a connection */
  public async dbDeleteConnection(connectionId: string): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("db:delete-connection", { connectionId });
  }

  /** DB Extension: open live connection */
  public async dbConnect(connectionId: string): Promise<{ success?: boolean; error?: string }> {
    return this.ipcRenderer.invoke("db:connect", { connectionId });
  }

  /** DB Extension: close live connection */
  public async dbDisconnect(connectionId: string): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("db:disconnect", { connectionId });
  }

  /** DB Extension: set active connection for workspace or global */
  public async dbSetActiveConnection(workspaceId: number | null, connectionId: string | null): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("db:set-active-connection", { workspaceId, connectionId });
  }

  /** DB Extension: test connection by id or by config (before save) */
  public async dbTestConnection(
    payload: { connectionId: string } | { type: string; config: Record<string, unknown> }
  ): Promise<{ success: boolean; error?: string }> {
    return this.ipcRenderer.invoke("db:test-connection", payload);
  }

  /** DB Extension: parse connection string to get type and config */
  public async dbParseConnectionString(connectionString: string): Promise<{
    type: string;
    config: Record<string, unknown>;
    database?: string;
  } | null> {
    return this.ipcRenderer.invoke("db:parse-connection-string", { connectionString });
  }

  /** DB Extension: get schema for active connection */
  public async dbGetSchema(workspaceId: number | null): Promise<{
    tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
    foreignKeys: Array<{ table: string; column: string; referencedTable: string; referencedColumn: string }>;
  } | null> {
    return this.ipcRenderer.invoke("db:get-schema", { workspaceId });
  }

  /** DB Extension: run read-only query */
  public async dbRunQuery(
    workspaceId: number | null,
    query: string
  ): Promise<{ rows?: unknown[]; error?: string }> {
    return this.ipcRenderer.invoke("db:run-query", { workspaceId, query });
  }

  /** DB Extension: get table data (first 50 rows) */
  public async dbGetTableData(
    workspaceId: number | null,
    table: string
  ): Promise<{ rows?: unknown[]; error?: string }> {
    return this.ipcRenderer.invoke("db:get-table-data", { workspaceId, table });
  }

  /** Get PIVOT nodes and edges for workspace (for Live vs Blueprint comparison). */
  public async getPivotNodesEdges(params: { workspaceId: number }): Promise<{
    success: boolean;
    nodes?: Array<{ id: string; type: string; label: string; filePath: string }>;
    edges?: Array<{ fromId: string; toId: string; type: string }>;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("pivot:get-nodes-edges", params);
  }

  /** Get blueprint snapshots for workspace (history). */
  public async getBlueprintSnapshots(params: { workspaceId: number; limit?: number }): Promise<{
    success: boolean;
    snapshots?: Array<{ id: number; snapshotAt: Date; source: string }>;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("pivot:get-snapshots", params);
  }

  /** Restore blueprint from a snapshot. */
  public async restoreBlueprintSnapshot(params: { workspaceId: number; snapshotId: number }): Promise<{
    success: boolean;
    blueprint?: import("@/shared/blueprint-types").Blueprint;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("pivot:restore-snapshot", params);
  }

  /** Run PIVOT analysis (SonarQube, Semgrep, SCIP) for workspace. */
  public async runPivotAnalysis(params: {
    workspaceId: number;
    projectKey?: string;
  }): Promise<{
    success: boolean;
    result?: {
      sonar: { success: boolean; issues?: Array<{ file: string; line?: number; message: string; severity: string; rule: string }>; error?: string };
      semgrep: { success: boolean; findings?: Array<{ path: string; start: { line: number }; message: string; severity: string; ruleId: string }>; error?: string };
      scip: { success: boolean; symbols?: unknown[]; error?: string };
    };
    error?: string;
  }> {
    return this.ipcRenderer.invoke("pivot:run-analysis", params);
  }

  /** Regenerate blueprint via AI clustering (5–8 containers from parsed nodes). */
  public async clusterBlueprint(params: { workspaceId: number }): Promise<{
    success: boolean;
    blueprint?: import("@/shared/blueprint-types").Blueprint;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("blueprint:cluster", params);
  }

  /** Generate scaffold from Blueprint delta (new files + .env.local keys) */
  public async blueprintCodegen(params: {
    workspaceId: number;
    delta: { rooms: Array<{ id: string; label: string; type?: string; intent?: string; functions: any[] }>; edges: Array<{ from: string; to: string; label?: string }>; envRefs: string[] };
  }): Promise<{ success: boolean; result?: { filesCreated: string[]; envKeysAdded: string[]; errors: string[] }; error?: string }> {
    return this.ipcRenderer.invoke("blueprint:codegen", params);
  }

  public onBlueprintAiEditing(listener: (payload: { workspaceId: number; action: string }) => void): () => void {
    const handler = (_: unknown, payload: { workspaceId: number; action: string }) => listener(payload);
    this.ipcRenderer.on("blueprint:ai-editing", handler);
    return () => this.ipcRenderer.removeListener("blueprint:ai-editing", handler);
  }

  /** When AI or main process updates the blueprint, sync to UI */
  public onBlueprintUpdated(listener: (payload: { workspaceId: number; blueprint: import("@/shared/blueprint-types").Blueprint }) => void): () => void {
    const handler = (_: unknown, payload: { workspaceId: number; blueprint: import("@/shared/blueprint-types").Blueprint }) => listener(payload);
    this.ipcRenderer.on("blueprint:updated", handler);
    return () => this.ipcRenderer.removeListener("blueprint:updated", handler);
  }

  /** When RTE is running (e.g. refresh from code), for legend and edge pulse */
  public onBlueprintRteRunning(listener: (payload: { workspaceId: number; running: boolean }) => void): () => void {
    const handler = (_: unknown, payload: { workspaceId: number; running: boolean }) => listener(payload);
    this.ipcRenderer.on("blueprint:rte-running", handler);
    return () => this.ipcRenderer.removeListener("blueprint:rte-running", handler);
  }

  /** Get diagram timeline (workspace snapshots for version history) */
  public async getDiagramTimeline(params: {
    appId: number;
    timeRange: "today" | "week" | "month" | "all";
  }): Promise<{ snapshots: any[]; totalCount: number }> {
    return this.ipcRenderer.invoke("diagram:get-timeline", params);
  }

  /** Get single diagram snapshot by ID */
  public async getDiagramSnapshot(snapshotId: number): Promise<{ architecture: string } | null> {
    return this.ipcRenderer.invoke("diagram:get-snapshot", snapshotId);
  }

  // --- Workspace Snapshots (Pro) ---
  public async createWorkspaceSnapshot(params: {
    appId: number;
    name: string;
    chatMessages?: Array<{ role: string; content: string }>;
  }): Promise<{ success: boolean; snapshotId?: number; error?: string }> {
    return this.ipcRenderer.invoke("workspace-snapshot:create", params);
  }

  public async listWorkspaceSnapshots(appId: number): Promise<{
    success: boolean;
    snapshots?: Array<{ id: number; name: string; createdAt: Date; fileCount: number }>;
  }> {
    return this.ipcRenderer.invoke("workspace-snapshot:list", appId);
  }

  public async restoreWorkspaceSnapshot(params: {
    snapshotId: number;
    appId: number;
  }): Promise<{ success: boolean; error?: string }> {
    return this.ipcRenderer.invoke("workspace-snapshot:restore", params);
  }

  // ============================================
  // DEV SERVER METHODS (Lovable-style Live Preview)
  // ============================================

  /**
   * Check if a workspace is a frontend project
   */
  public async isFrontendProject(workspaceId: number): Promise<{
    isFrontend: boolean;
    framework?: string | null;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("dev-server:is-frontend", { workspaceId });
  }

  /**
   * Start the dev server for a workspace
   */
  public async startDevServer(workspaceId: number): Promise<{
    success: boolean;
    url?: string;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("dev-server:start", { workspaceId });
  }

  /**
   * Stop the dev server for a workspace
   */
  public async stopDevServer(workspaceId: number): Promise<{
    success: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("dev-server:stop", { workspaceId });
  }

  /**
   * Get the status of a dev server
   */
  public async getDevServerStatus(workspaceId: number): Promise<{
    success: boolean;
    isRunning: boolean;
    url: string | null;
  }> {
    return this.ipcRenderer.invoke("dev-server:status", { workspaceId });
  }

  /**
   * Get all running dev servers
   */
  public async listRunningDevServers(): Promise<{
    success: boolean;
    servers: Array<{ workspaceId: number; url: string | null; framework: string }>;
  }> {
    return this.ipcRenderer.invoke("dev-server:list-running");
  }

  // ═══════════════════════════════════════════════════════════
  // FILE OPERATIONS (For live code editor)
  // ═══════════════════════════════════════════════════════════

  /**
   * Read file contents
   */
  public async readFileContent(filePath: string): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("file:read-content", { filePath });
  }

  /**
   * Write file contents
   */
  public async writeFileContent(filePath: string, content: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("file:write-content", { filePath, content });
  }

  /**
   * Get file stats (exists, size, modified time)
   */
  public async getFileStats(filePath: string): Promise<{
    success: boolean;
    exists?: boolean;
    size?: number;
    modifiedTime?: number;
    isDirectory?: boolean;
    error?: string;
  }> {
    return this.ipcRenderer.invoke("file:get-stats", { filePath });
  }
}

// Export function to get SearxNG config from main process (for use in main process only)
export async function getSearxngConfigFromMain(): Promise<{ url: string | null; enabled: boolean }> {
  if (typeof window !== 'undefined') {
    // In renderer, this shouldn't be called
    throw new Error('getSearxngConfigFromMain should only be called from main process');
  }

  // In main process, directly import and call the config
  // This is a workaround since we can't use IPC from main to main
  return { url: process.env.SEARXNG_API_URL || null, enabled: false };
}
