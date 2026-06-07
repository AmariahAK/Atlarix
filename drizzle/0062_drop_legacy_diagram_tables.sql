-- v12 S22 hotfix: the legacy `diagrams` table still carried
-- `FOREIGN KEY (chat_id) REFERENCES chats(id)` after 0058 dropped `chats`.
-- With foreign_keys ON, SQLite then fails to PREPARE any `DELETE FROM apps`
-- (it must compile the diagrams cascade and can't resolve the dead chats ref):
--   "Failed to delete workspace from database: no such table: main.chats".
-- Both tables are dead since the diagram-subsystem removal (nothing reads or
-- writes them; 0041 already dropped their sibling `diagram_versions`).
DROP TABLE IF EXISTS `diagrams`;
--> statement-breakpoint
DROP TABLE IF EXISTS `workspace_diagrams`;
