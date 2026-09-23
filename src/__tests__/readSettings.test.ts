import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import {
  readSettings,
  getSettingsFilePath,
  __injectSafeStorageForTests,
} from "@/main/settings";
import { getUserDataPath } from "@/paths/paths";
import { UserSettings } from "@/lib/schemas";
import { DEFAULT_NEW_USER_CORE_TIER } from "@/ipc/shared/compass_constants";

// Mock dependencies (electron stub lives in vitest.setup.ts)
vi.mock("node:fs");
vi.mock("node:path");
vi.mock("@/paths/paths", () => ({
  getUserDataPath: vi.fn(),
}));

const mockFs = vi.mocked(fs);
const mockPath = vi.mocked(path);
const mockSafeStorage = vi.mocked(safeStorage);
const mockGetUserDataPath = vi.mocked(getUserDataPath);

describe("readSettings", () => {
  const mockUserDataPath = "/mock/user/data";
  const mockSettingsPath = "/mock/user/data/user-settings.json";

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserDataPath.mockReturnValue(mockUserDataPath);
    mockPath.join.mockReturnValue(mockSettingsPath);
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    __injectSafeStorageForTests(mockSafeStorage);
  });

  afterEach(() => {
    __injectSafeStorageForTests(undefined);
    vi.restoreAllMocks();
  });

  describe("when settings file does not exist", () => {
    /**
     * NOTE for whoever next moves the new-user default tier: the `selectedModel`
     * inside the inline snapshots below is a LITERAL, because a snapshot cannot
     * interpolate a constant. Regenerate them (`-u`) rather than reading a failure
     * here as a bug. The guard that actually stops the default drifting apart from
     * the preference order lives in `core-tier-routing.test.ts`; these snapshots only
     * record what a fresh settings file comes out as.
     */
    it("should create default settings file and return default settings", () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = readSettings();

      expect(mockFs.existsSync).toHaveBeenCalledWith(mockSettingsPath);
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        mockSettingsPath,
        expect.stringContaining('"selectedModel"'),
      );
      expect(scrubSettings(result)).toMatchInlineSnapshot(`
        {
          "buildVerification": {
            "enabled": true,
          },
          "enableAutoUpdate": true,
          "hasRunBefore": false,
          "includeAtlarixCoAuthor": true,
          "isRunning": false,
          "lastKnownPerformance": undefined,
          "notificationSound": {
            "enabled": true,
            "volume": 0.7,
          },
          "providerSettings": {},
          "releaseChannel": "stable",
          "selectedChatMode": "ask",
          "selectedModel": {
            "name": "core-auto",
            "provider": "compass",
          },
          "telemetryConsent": "unset",
          "telemetryUserId": "[scrubbed]",
          "workModePreference": "ask",
        }
      `);
    });
  });

  describe("when settings file exists", () => {
    it("should read and merge settings with defaults", () => {
      const mockFileContent = {
        selectedModel: {
          name: "gpt-4",
          provider: "openai",
        },
        telemetryConsent: "opted_in",
        hasRunBefore: true,
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockFileContent));

      const result = readSettings();

      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        mockSettingsPath,
        "utf-8",
      );
      expect(result.selectedModel).toEqual({
        name: "gpt-4",
        provider: "openai",
      });
      expect(result.telemetryConsent).toBe("opted_in");
      expect(result.hasRunBefore).toBe(true);
      // Should still have defaults for missing properties
      expect(result.enableAutoUpdate).toBe(true);
      expect(result.releaseChannel).toBe("stable");
    });

    it("should decrypt encrypted provider API keys", () => {
      const mockFileContent = {
        providerSettings: {
          openai: {
            apiKey: {
              value: "encrypted-api-key",
              encryptionType: "electron-safe-storage",
            },
          },
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockFileContent));
      mockSafeStorage.decryptString.mockReturnValue("decrypted-api-key");

      const result = readSettings();

      expect(mockSafeStorage.decryptString).toHaveBeenCalledWith(
        Buffer.from("encrypted-api-key", "base64"),
      );
      expect(result.providerSettings.openai.apiKey).toEqual({
        value: "decrypted-api-key",
        encryptionType: "electron-safe-storage",
      });
    });

    it("should handle plaintext secrets without decryption", () => {
      const mockFileContent = {
        providerSettings: {
          openai: {
            apiKey: {
              value: "plaintext-api-key",
              encryptionType: "plaintext",
            },
          },
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockFileContent));

      const result = readSettings();

      expect(mockSafeStorage.decryptString).not.toHaveBeenCalled();
      expect(result.providerSettings.openai.apiKey?.value).toBe(
        "plaintext-api-key",
      );
    });

    it("should handle secrets without encryptionType", () => {
      const mockFileContent = {
        providerSettings: {
          openai: {
            apiKey: {
              value: "api-key-without-encryption-type",
            },
          },
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockFileContent));

      const result = readSettings();

      expect(mockSafeStorage.decryptString).not.toHaveBeenCalled();
      expect(result.providerSettings.openai.apiKey?.value).toBe(
        "api-key-without-encryption-type",
      );
    });

    it("should strip extra fields not recognized by the schema", () => {
      const mockFileContent = {
        selectedModel: {
          name: "gpt-4",
          provider: "openai",
        },
        telemetryConsent: "opted_in",
        hasRunBefore: true,
        // Extra fields that are not in the schema
        unknownField: "should be removed",
        deprecatedSetting: true,
        extraConfig: {
          someValue: 123,
          anotherValue: "test",
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockFileContent));

      const result = readSettings();

      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        mockSettingsPath,
        "utf-8",
      );
      expect(result.selectedModel).toEqual({
        name: "gpt-4",
        provider: "openai",
      });
      expect(result.telemetryConsent).toBe("opted_in");
      expect(result.hasRunBefore).toBe(true);

      // Extra fields should be stripped by schema validation
      expect(result).not.toHaveProperty("unknownField");
      expect(result).not.toHaveProperty("deprecatedSetting");
      expect(result).not.toHaveProperty("extraConfig");

      // Should still have defaults for missing properties
      expect(result.enableAutoUpdate).toBe(true);
      expect(result.releaseChannel).toBe("stable");
    });
  });

  describe("error handling", () => {
    it("should return default settings when file read fails", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error("File read error");
      });

      const result = readSettings();

      expect(scrubSettings(result)).toMatchInlineSnapshot(`
        {
          "buildVerification": {
            "enabled": true,
          },
          "enableAutoUpdate": true,
          "hasRunBefore": false,
          "includeAtlarixCoAuthor": true,
          "isRunning": false,
          "lastKnownPerformance": undefined,
          "notificationSound": {
            "enabled": true,
            "volume": 0.7,
          },
          "providerSettings": {},
          "releaseChannel": "stable",
          "selectedChatMode": "ask",
          "selectedModel": {
            "name": "core-auto",
            "provider": "compass",
          },
          "telemetryConsent": "unset",
          "telemetryUserId": "[scrubbed]",
          "workModePreference": "ask",
        }
      `);
    });

    it("should return default settings when JSON parsing fails", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("invalid json");

      const result = readSettings();

      expect(result).toMatchObject({
        selectedModel: {
          // The constant, not a literal: this is the new-user default, and writing
          // it down a third time is what let it drift from the preference order in
          // the first place. `core-tier-routing.test.ts` owns the drift guard.
          name: DEFAULT_NEW_USER_CORE_TIER,
          provider: "compass",
        },
        releaseChannel: "stable",
      });
    });

    it("should return default settings when schema validation fails", () => {
      const mockFileContent = {
        selectedModel: {
          name: "gpt-4",
          // Missing required 'provider' field
        },
        releaseChannel: "invalid-channel", // Invalid enum value
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockFileContent));

      const result = readSettings();

      expect(result).toMatchObject({
        selectedModel: {
          // The constant, not a literal: this is the new-user default, and writing
          // it down a third time is what let it drift from the preference order in
          // the first place. `core-tier-routing.test.ts` owns the drift guard.
          name: DEFAULT_NEW_USER_CORE_TIER,
          provider: "compass",
        },
        releaseChannel: "stable",
      });
    });

    it("should handle decryption errors gracefully", () => {
      // Fixture switched from `githubAccessToken` to a provider key when the
      // GitHub token was removed. This is the ONLY test exercising
      // `tryDecryptSecret`'s failure branch, so it had to move to a surviving
      // secret rather than be deleted with the field — dropping it would have
      // left corrupted provider keys uncovered.
      const mockFileContent = {
        providerSettings: {
          openai: {
            apiKey: {
              value: "corrupted-encrypted-data",
              encryptionType: "electron-safe-storage",
            },
          },
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockFileContent));
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error("Decryption failed");
      });

      const result = readSettings();

      expect(result).toMatchObject({
        selectedModel: {
          // The constant, not a literal: this is the new-user default, and writing
          // it down a third time is what let it drift from the preference order in
          // the first place. `core-tier-routing.test.ts` owns the drift guard.
          name: DEFAULT_NEW_USER_CORE_TIER,
          provider: "compass",
        },
        releaseChannel: "stable",
      });
    });

    it("normalizes legacy compass-* model selections to core-N (v11)", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          selectedModel: { name: "compass-balanced", provider: "compass" },
        }),
      );

      const result = readSettings();

      expect(result.selectedModel).toEqual({
        name: "core-2",
        provider: "compass",
      });
    });

    it("coerces removed fast/balanced summarization & review tiers to 'same' (v13.6)", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          aiConfiguration: {
            contextSummarization: { summarizationModel: "balanced" },
            selfReview: { reviewModel: "fast" },
            guided: { agentModel: "fast" },
          },
        }),
      );

      const result = readSettings();

      expect(
        result.aiConfiguration?.contextSummarization?.summarizationModel,
      ).toBe("same");
      expect(result.aiConfiguration?.selfReview?.reviewModel).toBe("same");
      expect(result.aiConfiguration?.guided?.agentModel).toBe("same");
    });
  });

  describe("getSettingsFilePath", () => {
    it("should return correct settings file path", () => {
      const result = getSettingsFilePath();

      expect(mockGetUserDataPath).toHaveBeenCalled();
      expect(mockPath.join).toHaveBeenCalledWith(
        mockUserDataPath,
        "user-settings.json",
      );
      expect(result).toBe(mockSettingsPath);
    });
  });
});

function scrubSettings(result: UserSettings) {
  return {
    ...result,
    telemetryUserId: "[scrubbed]",
  };
}
