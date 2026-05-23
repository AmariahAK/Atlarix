/** Shared shape for workspace ctags / regex file parsing. */

export interface ParsedFileResult {
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  functionCalls: string[];
  classInstantiations: string[];
}
