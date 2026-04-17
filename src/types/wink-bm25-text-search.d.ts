declare module "wink-bm25-text-search" {
  export interface WinkBm25Engine {
    defineConfig(config: {
      fldWeights: Record<string, number>;
      bm25Params?: { k1?: number; b?: number; k?: number };
      ovFldNames?: string[];
    }): unknown;
    definePrepTasks(
      tasks: Array<(text: string) => string[]>,
      field?: string,
    ): unknown;
    addDoc(doc: Record<string, string>, uniqueId: number): unknown;
    consolidate(fp?: number): unknown;
    search(
      text: string,
      limit?: number,
      filter?: (doc: Record<string, string>, params: unknown) => boolean,
      params?: unknown,
    ): Array<[number, number]>;
    reset(): unknown;
  }

  function createEngine(): WinkBm25Engine;
  export = createEngine;
}
