/**
 * PIVOT service — save/load nodes, edges, and blueprint snapshots to SQLite.
 */

import { db } from "@/db";
import {
  pivotNodes,
  pivotEdges,
  pivotContainers,
  pivotBeacons,
  blueprintSnapshots,
} from "@/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import type {
  PivotNode,
  PivotEdge,
  Container,
  Beacon,
  BlueprintSnapshotSource,
} from "./types";
import log from "electron-log";

const logger = log.scope("pivot-service");

/** Save nodes and edges for a workspace (replaces existing). */
export async function saveNodesAndEdges(
  workspaceId: number,
  nodes: PivotNode[],
  edges: PivotEdge[],
): Promise<void> {
  await db.delete(pivotEdges).where(eq(pivotEdges.workspaceId, workspaceId));
  await db.delete(pivotNodes).where(eq(pivotNodes.workspaceId, workspaceId));

  if (nodes.length > 0) {
    await db.insert(pivotNodes).values(
      nodes.map((n) => ({
        workspaceId,
        externalId: n.id,
        type: n.type,
        label: n.label,
        filePath: n.filePath,
        rangeStart: n.rangeStart ?? null,
        rangeEnd: n.rangeEnd ?? null,
        metadata: n.metadata ?? null,
      })),
    );
  }
  if (edges.length > 0) {
    await db.insert(pivotEdges).values(
      edges.map((e) => ({
        workspaceId,
        fromId: e.fromId,
        toId: e.toId,
        type: e.type,
        metadata: e.metadata ?? null,
      })),
    );
  }
  logger.debug("saveNodesAndEdges", { workspaceId, nodes: nodes.length, edges: edges.length });
}

/** Load nodes and edges for a workspace. */
export async function loadNodesAndEdges(
  workspaceId: number,
): Promise<{ nodes: PivotNode[]; edges: PivotEdge[] }> {
  const rows = await db
    .select()
    .from(pivotNodes)
    .where(eq(pivotNodes.workspaceId, workspaceId));
  const edgeRows = await db
    .select()
    .from(pivotEdges)
    .where(eq(pivotEdges.workspaceId, workspaceId));

  const nodes: PivotNode[] = rows.map((r) => ({
    id: r.externalId,
    type: r.type as PivotNode["type"],
    label: r.label,
    filePath: r.filePath,
    rangeStart: r.rangeStart ?? undefined,
    rangeEnd: r.rangeEnd ?? undefined,
    metadata: (r.metadata as Record<string, unknown>) ?? undefined,
  }));
  const edges: PivotEdge[] = edgeRows.map((r) => ({
    id: `e_${r.id}`,
    fromId: r.fromId,
    toId: r.toId,
    type: r.type as PivotEdge["type"],
    metadata: (r.metadata as Record<string, unknown>) ?? undefined,
  }));
  return { nodes, edges };
}

/** Save a blueprint snapshot. */
export async function saveBlueprintSnapshot(
  workspaceId: number,
  blueprintJson: string,
  source: BlueprintSnapshotSource,
): Promise<number> {
  const [row] = await db
    .insert(blueprintSnapshots)
    .values({
      workspaceId,
      blueprintJson,
      source,
    })
    .returning({ id: blueprintSnapshots.id });
  if (!row) throw new Error("Failed to insert blueprint snapshot");
  logger.debug("saveBlueprintSnapshot", { workspaceId, source, id: row.id });
  return row.id;
}

/** List snapshots for a workspace (newest first). */
export async function loadBlueprintSnapshots(
  workspaceId: number,
  limit = 50,
): Promise<Array<{ id: number; snapshotAt: Date; source: BlueprintSnapshotSource }>> {
  const rows = await db
    .select({
      id: blueprintSnapshots.id,
      snapshotAt: blueprintSnapshots.snapshotAt,
      source: blueprintSnapshots.source,
    })
    .from(blueprintSnapshots)
    .where(eq(blueprintSnapshots.workspaceId, workspaceId))
    .orderBy(desc(blueprintSnapshots.snapshotAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    snapshotAt: r.snapshotAt as Date,
    source: r.source as BlueprintSnapshotSource,
  }));
}

/** Get a single snapshot by id. */
export async function getBlueprintSnapshot(
  snapshotId: number,
): Promise<{ workspaceId: number; blueprintJson: string; source: BlueprintSnapshotSource } | null> {
  const [row] = await db
    .select({
      workspaceId: blueprintSnapshots.workspaceId,
      blueprintJson: blueprintSnapshots.blueprintJson,
      source: blueprintSnapshots.source,
    })
    .from(blueprintSnapshots)
    .where(eq(blueprintSnapshots.id, snapshotId))
    .limit(1);
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    blueprintJson: row.blueprintJson,
    source: row.source as BlueprintSnapshotSource,
  };
}

/** Get the latest snapshot for a workspace (optional source filter). */
export async function getLatestBlueprintSnapshot(
  workspaceId: number,
  source?: BlueprintSnapshotSource,
): Promise<{ id: number; blueprintJson: string } | null> {
  let q = db
    .select({ id: blueprintSnapshots.id, blueprintJson: blueprintSnapshots.blueprintJson })
    .from(blueprintSnapshots)
    .where(eq(blueprintSnapshots.workspaceId, workspaceId))
    .orderBy(desc(blueprintSnapshots.snapshotAt))
    .limit(1);
  const rows = await q;
  const row = rows[0];
  if (!row) return null;
  if (source) {
    const full = await db
      .select()
      .from(blueprintSnapshots)
      .where(
        and(
          eq(blueprintSnapshots.workspaceId, workspaceId),
          eq(blueprintSnapshots.source, source),
        ),
      )
      .orderBy(desc(blueprintSnapshots.snapshotAt))
      .limit(1);
    const r = full[0];
    if (!r) return null;
    return { id: r.id, blueprintJson: r.blueprintJson };
  }
  return { id: row.id, blueprintJson: row.blueprintJson };
}

/** Save containers and beacons (e.g. from AI clustering). Replaces existing for workspace. */
export async function saveContainersAndBeacons(
  workspaceId: number,
  containers: Container[],
  beacons: Beacon[],
): Promise<void> {
  const existingContainers = await db
    .select({ id: pivotContainers.id })
    .from(pivotContainers)
    .where(eq(pivotContainers.workspaceId, workspaceId));
  for (const c of existingContainers) {
    await db.delete(pivotBeacons).where(eq(pivotBeacons.containerId, c.id));
  }
  await db.delete(pivotContainers).where(eq(pivotContainers.workspaceId, workspaceId));

  if (containers.length > 0) {
    await db.insert(pivotContainers).values(
      containers.map((c) => ({
        id: c.id,
        workspaceId,
        label: c.label,
        intent: c.intent ?? null,
        position: c.position ?? null,
      })),
    );
  }
  if (beacons.length > 0) {
    await db.insert(pivotBeacons).values(
      beacons.map((b) => ({
        id: b.id,
        containerId: b.containerId,
        label: b.label,
        kind: b.kind,
        description: b.description ?? null,
        filePath: b.filePath ?? null,
        position: b.position ?? null,
      })),
    );
  }
  logger.debug("saveContainersAndBeacons", { workspaceId, containers: containers.length, beacons: beacons.length });
}

/** Load containers and beacons for a workspace. */
export async function loadContainersAndBeacons(
  workspaceId: number,
): Promise<{ containers: Container[]; beacons: Beacon[] }> {
  const containerRows = await db
    .select()
    .from(pivotContainers)
    .where(eq(pivotContainers.workspaceId, workspaceId));
  const containerIds = containerRows.map((c) => c.id);
  const allBeaconRows =
    containerIds.length === 0
      ? []
      : await db.select().from(pivotBeacons).where(inArray(pivotBeacons.containerId, containerIds));
  const byContainer = new Map<string, typeof allBeaconRows>();
  for (const b of allBeaconRows) {
    const list = byContainer.get(b.containerId) ?? [];
    list.push(b);
    byContainer.set(b.containerId, list);
  }
  const containers: Container[] = containerRows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    label: r.label,
    intent: r.intent ?? undefined,
    position: (r.position as { x: number; y: number }) ?? undefined,
    createdAt: r.createdAt ? new Date(r.createdAt).getTime() : undefined,
  }));
  const beacons: Beacon[] = containerRows.flatMap((c) => {
    const list = byContainer.get(c.id) ?? [];
    return list.map((b) => ({
      id: b.id,
      containerId: b.containerId,
      label: b.label,
      kind: b.kind as Beacon["kind"],
      description: b.description ?? undefined,
      filePath: b.filePath ?? undefined,
      position: (b.position as { x: number; y: number }) ?? undefined,
    }));
  });
  return { containers, beacons };
}
