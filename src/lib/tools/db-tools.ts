/**
 * DB Extension tools — auto-registers db_query, db_schema, db_list, db_mutate
 * in the global ToolRegistry.
 */

import { ToolRegistry } from "./registry";
import { getDBTools } from "../workforce/db-extension/db-tools";

for (const tool of getDBTools()) {
  ToolRegistry.register(tool);
}
