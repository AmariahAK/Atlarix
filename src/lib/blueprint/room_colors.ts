/**
 * Color and label by room type (API, backend, frontend, DB, webhook, devops, etc.)
 * Used by BlueprintRoomNode for visual differentiation.
 */

import type { BlueprintRoom } from "@/shared/blueprint-types";

export type RoomTypeKey =
  | "frontend"
  | "backend"
  | "api"
  | "database"
  | "webhook"
  | "devops"
  | "integration"
  | "module"
  | "default";

export interface RoomTypeStyle {
  bg: string;
  border: string;
  label: string;
  badgeClass: string;
}

export const ROOM_STYLES: Record<RoomTypeKey, RoomTypeStyle> = {
  frontend: {
    bg: "bg-blue-500/10",
    border: "border-blue-500/60",
    label: "Frontend",
    badgeClass: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  },
  backend: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/60",
    label: "Backend",
    badgeClass: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
  },
  api: {
    bg: "bg-violet-500/10",
    border: "border-violet-500/60",
    label: "API",
    badgeClass: "bg-violet-500/20 text-violet-400 border-violet-500/40",
  },
  database: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/60",
    label: "Database",
    badgeClass: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  },
  webhook: {
    bg: "bg-pink-500/10",
    border: "border-pink-500/60",
    label: "Webhook",
    badgeClass: "bg-pink-500/20 text-pink-400 border-pink-500/40",
  },
  devops: {
    bg: "bg-cyan-500/10",
    border: "border-cyan-500/60",
    label: "DevOps",
    badgeClass: "bg-cyan-500/20 text-cyan-400 border-cyan-500/40",
  },
  integration: {
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/60",
    label: "Integration",
    badgeClass: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
  },
  module: {
    bg: "bg-slate-500/10",
    border: "border-slate-500/60",
    label: "Container",
    badgeClass: "bg-slate-500/20 text-slate-400 border-slate-500/40",
  },
  default: {
    bg: "bg-slate-500/10",
    border: "border-slate-500/60",
    label: "Container",
    badgeClass: "bg-slate-500/20 text-slate-400 border-slate-500/40",
  },
};

export function detectRoomType(room: BlueprintRoom): RoomTypeKey {
  const name = (room.label ?? "").toLowerCase();
  const type = (room.type ?? "").toLowerCase();
  const intent = (room.intent ?? "").toLowerCase();
  const combined = `${name} ${type} ${intent}`;
  const fnNames = (room.functions ?? []).map((f) => (f.name ?? "").toLowerCase()).join(" ");

  if (
    /component|page|view|ui|layout/.test(combined) ||
    /render|jsx|tsx|component/.test(fnNames)
  ) {
    return "frontend";
  }
  if (
    /api|route|endpoint|handler/.test(combined) ||
    /get|post|put|delete|patch|fetch/.test(fnNames)
  ) {
    return "api";
  }
  if (
    /model|schema|repository|db|database|migration/.test(combined) ||
    /query|find|insert|update|delete/.test(fnNames)
  ) {
    return "database";
  }
  if (/webhook|hook/.test(combined) || /webhook/.test(fnNames)) {
    return "webhook";
  }
  if (/config|deploy|docker|k8s|ci|pipeline/.test(combined)) {
    return "devops";
  }
  if (/stripe|slack|email|integration|oauth/.test(combined)) {
    return "integration";
  }
  if (/service|controller|handler|logic|core/.test(combined)) {
    return "backend";
  }
  if (/src|lib|util|shared|common/.test(combined)) {
    return "module";
  }
  return "default";
}

export function getRoomStyle(room: BlueprintRoom): RoomTypeStyle {
  return ROOM_STYLES[detectRoomType(room)];
}
