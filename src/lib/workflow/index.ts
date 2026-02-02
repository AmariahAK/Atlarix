/**
 * Workflow module - v2+ n8n-style workflow as prompt
 * Round-trip: project ↔ AppMap ↔ Atlaflow ↔ diagram (see docs/ATLAFLOW_ROUNDTRIP.md)
 */

export {
  parseWorkflow,
  hasWorkflowJson,
  workflowToPrompt,
  processPromptForWorkflow,
  type ParsedWorkflow,
  type WorkflowNode,
  type WorkflowConnection,
  type TechStack,
} from "./workflow_parser";
export { inferWorkflowFromProject } from "./project_to_workflow";
export { getNodeDefinition, mapWorkflowToStack } from "./n8n_node_registry";
export { getCredentialDefinition, getCredentialMapping } from "./n8n_credential_loader";
export {
  workflowToReactFlow,
  reactFlowToWorkflow,
  type AtlaflowWorkflow,
} from "./atlaflow_converter";
export type { AppMap, AppMapEntryPoint, AppMapDataSource, AppMapFlow, AppMapScreen, Runtime } from "./app_map_types";
export { appMapToAtlaflow, ATLAFLOW_ENTRY, ATLAFLOW_DATA, ATLAFLOW_SCREEN } from "./app_map_to_atlaflow";
export { atlaflowToAppMap } from "./atlaflow_to_app_map";
