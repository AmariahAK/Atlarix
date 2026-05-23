/**
 * Build StructureResult from ctags SymbolRecord[] (replaces oxc-structure for getStructureScan).
 */

import type { SymbolRecord } from "./symbol-types";
import type { StructureResult } from "@/ipc/utils/project-files";

function isFunctionKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "f" || k === "function" || k === "m" || k === "method";
}

function isClassKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "c" || k === "class";
}

function isTypeKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return (
    k === "i" ||
    k === "interface" ||
    k === "t" ||
    k === "type" ||
    k === "e" ||
    k === "enum"
  );
}

function isConstKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "v" || k === "variable" || k === "constant" || k === "d" || k === "define";
}

export function structureFromSymbols(symbols: SymbolRecord[]): StructureResult {
  const result: StructureResult = {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    types: [],
    constants: [],
  };

  for (const s of symbols) {
    if (isFunctionKind(s.kind)) {
      result.functions.push(s.name);
    } else if (isClassKind(s.kind)) {
      result.classes.push(s.name);
    } else if (isTypeKind(s.kind)) {
      result.types!.push(s.name);
    } else if (isConstKind(s.kind)) {
      result.constants!.push(s.name);
    }
  }

  result.exports = [
    ...result.functions,
    ...result.classes,
    ...(result.types ?? []),
  ];

  return result;
}
