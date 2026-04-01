-- pivot_nodes: type -> node_type
ALTER TABLE pivot_nodes RENAME COLUMN type TO node_type;

--> statement-breakpoint

-- pivot_edges: type -> edge_type
ALTER TABLE pivot_edges RENAME COLUMN type TO edge_type;

--> statement-breakpoint

-- diagrams: type -> diagram_type
ALTER TABLE diagrams RENAME COLUMN type TO diagram_type;
