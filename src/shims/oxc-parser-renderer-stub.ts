/**
 * Renderer Vite bundle must not load oxc-parser's real package: its "browser" field
 * points at wasm/WASI and breaks esbuild. RTE uses oxc only in the Electron main process.
 */

export function parseSync(_filename: string, _source: string): never {
  throw new Error("oxc-parser is main-process only");
}

const stub = { parseSync };
export default stub;
