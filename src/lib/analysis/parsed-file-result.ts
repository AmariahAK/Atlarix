/** Shared shape for workspace tree-sitter / regex file parsing. */

export interface ParsedFileResult {
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  functionCalls: string[];
  classInstantiations: string[];
}
