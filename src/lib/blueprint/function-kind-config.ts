/**
 * Config for Blueprint function kinds (API, Webhook, Function, Feature).
 * Used in Edit container details list: icon + label + style per type (Phase A).
 *
 * Motia-style step types (v2.2): [API], [WH], [FN], [CLS], [DB], [3P], [AI], [STREAM], [CRON].
 * This config covers the primary four; others map to "function" for display.
 */

import type { LucideIcon } from "lucide-react";
import { Plug, Webhook, Zap, Layout } from "lucide-react";
import type { BlueprintFunctionKind } from "@/shared/blueprint-types";

export interface FunctionKindConfig {
  label: string;
  Icon: LucideIcon;
  /** Left border + list row accent */
  borderClass: string;
  /** Icon color */
  iconClass: string;
  /** Short hint for config (e.g. "Key in .env") */
  configHint: string;
}

export const FUNCTION_KIND_CONFIG: Record<BlueprintFunctionKind, FunctionKindConfig> = {
  api: {
    label: "API",
    Icon: Plug,
    borderClass: "border-l-blue-500/60",
    iconClass: "text-blue-400",
    configHint: "Provider, key in .env",
  },
  webhook: {
    label: "Webhook",
    Icon: Webhook,
    borderClass: "border-l-purple-500/60",
    iconClass: "text-purple-400",
    configHint: "Trigger, key in .env",
  },
  function: {
    label: "Function",
    Icon: Zap,
    borderClass: "border-l-orange-500/60",
    iconClass: "text-orange-400",
    configHint: "Calls, returns",
  },
  feature: {
    label: "Feature",
    Icon: Layout,
    borderClass: "border-l-green-500/60",
    iconClass: "text-green-400",
    configHint: "Props, component",
  },
};
