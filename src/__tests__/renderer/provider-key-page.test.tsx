/**
 * QA (app) #24: a custom provider's key read "Setup Complete" the moment it
 * was saved — nothing checked it, and the first chat failed with 401 — and
 * the page printed the whole key (the input showed it in clear as typed).
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { ProviderSettingsHeader } from "@/components/settings/ProviderSettingsHeader";
import { ApiKeyConfiguration } from "@/components/settings/ApiKeyConfiguration";

const KEY = "sk-proj-qa-definitely-not-a-real-key-000000";

describe("a provider's key page", () => {
  it("says the key was rejected when the provider refuses it", () => {
    renderWithProviders(
      <ProviderSettingsHeader
        providerDisplayName="QA Bad Key"
        isConfigured
        keyCheck={{ status: "rejected", detail: "Incorrect API key provided" }}
        isLoading={false}
        onBackClick={() => {}}
      />,
    );
    expect(screen.getByText("Key rejected")).toBeTruthy();
    expect(screen.getByText("Incorrect API key provided")).toBeTruthy();
    expect(screen.queryByText("Setup Complete")).toBeNull();
  });

  it("an endpoint whose key can't be checked yet says so, not 'Setup Complete' (QA)", () => {
    const detail = "This endpoint doesn't list its models, so the key is checked by the first message.";
    renderWithProviders(
      <ProviderSettingsHeader
        providerDisplayName="Bedrock"
        isConfigured
        keyCheck={{ status: "unchecked", detail }}
        isLoading={false}
        onBackClick={() => {}}
      />,
    );
    expect(screen.getByText("Key saved")).toBeTruthy();
    expect(screen.getByText(detail)).toBeTruthy();
    expect(screen.queryByText("Setup Complete")).toBeNull();
  });

  it("shows the saved key masked, and hides what you type", () => {
    const { container } = renderWithProviders(
      <ApiKeyConfiguration
        provider="custom::qa"
        providerDisplayName="QA"
        settings={{ providerSettings: { "custom::qa": { apiKey: { value: KEY } } } } as never}
        envVars={{}}
        isSaving={false}
        saveError={null}
        apiKeyInput=""
        onApiKeyInputChange={() => {}}
        onSaveKey={async () => {}}
        onDeleteKey={async () => {}}
        updateSettings={async () => ({}) as never}
      />,
    );
    expect(screen.queryByText(KEY)).toBeNull();
    expect(screen.getByText("sk-…0000")).toBeTruthy();
    expect(container.querySelector("#apiKeyInput")?.getAttribute("type")).toBe("password");
  });
});

import { unreachableDetail } from "@/components/settings/ProviderSettingsHeader";
describe("an unreachable provider's page", () => {
  it("doesn't repeat the label, or say just 'fetch failed'", () => {
    expect(unreachableDetail("Couldn't reach the provider: fetch failed")).toBe("Check it's running and the address is right.");
    expect(unreachableDetail("Couldn't reach the provider: connect ECONNREFUSED 127.0.0.1:59999")).toBe("connect ECONNREFUSED 127.0.0.1:59999");
  });
});
