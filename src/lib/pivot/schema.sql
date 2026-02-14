-- v2.5 PIVOT — SQLite graph storage for Code ↔ Canvas ↔ Blueprint
-- Tables: nodes, edges, containers, beacons, container_nodes, beacon_edges, blueprint_snapshots

-- Structural nodes extracted from code (functions, classes, APIs, etc.)
CREATE TABLE IF NOT EXISTS pivot_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  framework_hint TEXT,
  env_refs TEXT, -- JSON array of env key names
  project_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Edges between nodes (calls, imports, inherits)
CREATE TABLE IF NOT EXISTS pivot_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  project_hash TEXT NOT NULL,
  FOREIGN KEY (from_id) REFERENCES pivot_nodes(id),
  FOREIGN KEY (to_id) REFERENCES pivot_nodes(id)
);

-- Containers = high-level components (Auth API, Payment Service)
CREATE TABLE IF NOT EXISTS pivot_containers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  intent TEXT,
  type TEXT,
  project_hash TEXT NOT NULL,
  blueprint_snapshot_id TEXT,
  created_at INTEGER NOT NULL
);

-- Which nodes belong to which container
CREATE TABLE IF NOT EXISTS pivot_container_nodes (
  container_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (container_id, node_id),
  FOREIGN KEY (container_id) REFERENCES pivot_containers(id),
  FOREIGN KEY (node_id) REFERENCES pivot_nodes(id)
);

-- Beacons = functionality inside a container (Login, Send Email)
CREATE TABLE IF NOT EXISTS pivot_beacons (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  env_refs TEXT, -- JSON array
  blueprint_snapshot_id TEXT,
  FOREIGN KEY (container_id) REFERENCES pivot_containers(id)
);

-- Which nodes belong to which beacon
CREATE TABLE IF NOT EXISTS pivot_beacon_nodes (
  beacon_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (beacon_id, node_id),
  FOREIGN KEY (beacon_id) REFERENCES pivot_beacons(id),
  FOREIGN KEY (node_id) REFERENCES pivot_nodes(id)
);

-- Edges between beacons (flow)
CREATE TABLE IF NOT EXISTS pivot_beacon_edges (
  id TEXT PRIMARY KEY,
  from_beacon_id TEXT NOT NULL,
  to_beacon_id TEXT NOT NULL,
  label TEXT,
  FOREIGN KEY (from_beacon_id) REFERENCES pivot_beacons(id),
  FOREIGN KEY (to_beacon_id) REFERENCES pivot_beacons(id)
);

-- Blueprint snapshots for history / comparison
CREATE TABLE IF NOT EXISTS pivot_blueprint_snapshots (
  id TEXT PRIMARY KEY,
  project_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, -- PivotBlueprint JSON
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pivot_nodes_project ON pivot_nodes(project_hash);
CREATE INDEX IF NOT EXISTS idx_pivot_edges_project ON pivot_edges(project_hash);
CREATE INDEX IF NOT EXISTS idx_pivot_containers_project ON pivot_containers(project_hash);
CREATE INDEX IF NOT EXISTS idx_pivot_beacons_container ON pivot_beacons(container_id);
CREATE INDEX IF NOT EXISTS idx_pivot_snapshots_project ON pivot_blueprint_snapshots(project_hash);
