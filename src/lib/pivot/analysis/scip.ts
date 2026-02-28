/**
 * SCIP integration placeholder for PIVOT analysis layer.
 * Use for symbol resolution / go-to-definition when SCIP index is available.
 * Optional: can be phased (e.g. generate or consume index in background).
 */

export interface ScipConfig {
  /** Path to SCIP index file (e.g. .scip/index.scip) */
  indexPath?: string;
}

export interface ScipSymbol {
  path: string;
  line: number;
  symbol: string;
  kind?: string;
}

export interface ScipResult {
  success: boolean;
  symbols?: ScipSymbol[];
  error?: string;
}

/**
 * Placeholder: SCIP index consumption. Returns empty until implemented.
 * Future: read .scip/index.scip or run scip-typescript and parse output.
 */
export async function getScipSymbols(
  _workspacePath: string,
  _config: ScipConfig | null = null,
): Promise<ScipResult> {
  return {
    success: true,
    symbols: [],
    error: undefined,
  };
}
