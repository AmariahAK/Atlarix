import { IpcClient } from "@/ipc/ipc_client";
import { useState } from "react";
import { KeyRound } from "lucide-react";

import { useSettings } from "@/hooks/useSettings";
import { useUserBudgetInfo } from "@/hooks/useUserBudgetInfo";
import { Button } from "./ui/button";

export function ProBanner() {
  const { settings } = useSettings();
  const { userBudget } = useUserBudgetInfo();

  const [selectedBanner] = useState<"ai" | "smart" | "turbo">(() => {
    const options = ["ai", "smart", "turbo"] as const;
    return options[Math.floor(Math.random() * options.length)];
  });

  if (settings?.enableAtlarixPro || userBudget) {
    return (
      <div className="mt-6 max-w-2xl mx-auto">
        <ManageAtlarixProButton />
      </div>
    );
  }

  return (
    <div className="mt-6 max-w-2xl mx-auto">
      {selectedBanner === "ai" ? (
        <AiAccessBanner />
      ) : selectedBanner === "smart" ? (
        <SmartContextBanner />
      ) : (
        <TurboBanner />
      )}
      <SetupAtlarixProButton />
    </div>
  );
}

export function ManageAtlarixProButton() {
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full mt-4 bg-(--background-lighter) text-primary"
      onClick={() => {
        IpcClient.getInstance().openExternalUrl(
          "https://atlarix.com/pricing",
        );
      }}
    >
      <KeyRound aria-hidden="true" />
      Manage Atlarix Pro subscription
    </Button>
  );
}

export function SetupAtlarixProButton() {
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full mt-4 bg-(--background-lighter) text-primary"
      onClick={() => {
        IpcClient.getInstance().openExternalUrl(
          "https://atlarix.com/settings",
        );
      }}
    >
      <KeyRound aria-hidden="true" />
      Already have Atlarix Pro? Add your key
    </Button>
  );
}

export function AiAccessBanner() {
  return (
    <div
      className="w-full py-2 sm:py-2.5 md:py-3 rounded-lg bg-gradient-to-br from-white via-indigo-50 to-sky-100 dark:from-indigo-700 dark:via-indigo-700 dark:to-indigo-900 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-black/5 dark:ring-white/10 shadow-sm cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-[1px]"
      onClick={() => {
        IpcClient.getInstance().openExternalUrl(
          "https://atlarix.com/pricing?utm_source=atlarix-app&utm_medium=app&utm_campaign=in-app-banner-ai-access",
        );
      }}
    >
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="absolute inset-0 z-0 pointer-events-none dark:hidden">
        <div className="absolute -top-8 -left-6 h-40 w-40 rounded-full blur-2xl bg-violet-200/40" />
        <div className="absolute -bottom-10 -right-6 h-48 w-48 rounded-full blur-3xl bg-sky-200/40" />
      </div>
      <div className="relative z-10 text-center flex flex-col items-center gap-0.5 sm:gap-1 md:gap-1.5 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="text-xl font-semibold tracking-tight text-indigo-900 dark:text-indigo-100">
            Use local or cloud AI models
          </div>
          <button
            type="button"
            aria-label="Subscribe to Atlarix Pro"
            className="inline-flex items-center rounded-md bg-white/90 text-indigo-800 hover:bg-white shadow px-3 py-1.5 text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-white/50"
          >
            Upgrade to Atlarix Pro
          </button>
        </div>

        <div className="mt-1.5 sm:mt-2 flex gap-4 md:gap-6 items-center justify-center opacity-90">
          <div className="text-sm font-medium text-indigo-800 dark:text-indigo-200">
            Ollama
          </div>
          <div className="text-indigo-400 dark:text-indigo-400"> • </div>
          <div className="text-sm font-medium text-indigo-800 dark:text-indigo-200">
            LM Studio
          </div>
          <div className="text-indigo-400 dark:text-indigo-400"> • </div>
          <div className="text-sm font-medium text-indigo-800 dark:text-indigo-200">
            OpenRouter
          </div>
        </div>
      </div>
    </div>
  );
}

export function SmartContextBanner() {
  return (
    <div
      className="w-full py-2 sm:py-2.5 md:py-3 rounded-lg bg-gradient-to-br from-emerald-50 via-emerald-100 to-emerald-200 dark:from-emerald-700 dark:via-emerald-700 dark:to-emerald-900 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-emerald-900/10 dark:ring-white/10 shadow-sm cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-[1px]"
      onClick={() => {
        IpcClient.getInstance().openExternalUrl(
          "https://atlarix.com/pricing?utm_source=atlarix-app&utm_medium=app&utm_campaign=in-app-banner",
        );
      }}
    >
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="absolute inset-0 z-0 pointer-events-none dark:hidden">
        <div className="absolute -top-10 -left-8 h-44 w-44 rounded-full blur-2xl bg-emerald-200/50" />
        <div className="absolute -bottom-12 -right-8 h-56 w-56 rounded-full blur-3xl bg-teal-200/50" />
      </div>
      <div className="relative z-10 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="flex flex-col items-center text-center">
            <div className="text-xl font-semibold tracking-tight text-emerald-900 dark:text-emerald-100">
              5 free prompts/day
            </div>
            <div className="text-sm sm:text-base mt-1 text-emerald-700 dark:text-emerald-200/80">
              with AI-Powered Workspace
            </div>
          </div>
          <button
            type="button"
            aria-label="Upgrade to Atlarix Pro"
            className="inline-flex items-center rounded-md bg-white/90 text-emerald-800 hover:bg-white shadow px-3 py-1.5 text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-white/50"
          >
            Upgrade to Atlarix Pro
          </button>
        </div>
      </div>
    </div>
  );
}

export function TurboBanner() {
  return (
    <div
      className="w-full py-2 sm:py-2.5 md:py-3 rounded-lg bg-gradient-to-br from-rose-50 via-rose-100 to-rose-200 dark:from-rose-800 dark:via-fuchsia-800 dark:to-rose-800 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-rose-900/10 dark:ring-white/5 shadow-sm cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-[1px]"
      onClick={() => {
        IpcClient.getInstance().openExternalUrl(
          "https://atlarix.com/pricing?utm_source=atlarix-app&utm_medium=app&utm_campaign=in-app-banner-turbo",
        );
      }}
    >
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="absolute inset-0 z-0 pointer-events-none dark:hidden">
        <div className="absolute -top-10 -left-8 h-44 w-44 rounded-full blur-2xl bg-rose-200/50" />
        <div className="absolute -bottom-12 -right-8 h-56 w-56 rounded-full blur-3xl bg-fuchsia-200/50" />
      </div>
      <div className="relative z-10 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="flex flex-col items-center text-center">
            <div className="text-xl font-semibold tracking-tight text-rose-900 dark:text-rose-100">
              Generate code 4–10x faster
            </div>
            <div className="text-sm sm:text-base mt-1 text-rose-700 dark:text-rose-200/80">
              with Turbo Models & Turbo Edits
            </div>
          </div>
          <button
            type="button"
            aria-label="Upgrade to Atlarix Pro"
            className="inline-flex items-center rounded-md bg-white/90 text-rose-800 hover:bg-white shadow px-3 py-1.5 text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-white/50"
          >
            Upgrade to Atlarix Pro
          </button>
        </div>
      </div>
    </div>
  );
}
