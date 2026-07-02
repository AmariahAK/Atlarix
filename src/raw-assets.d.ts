// Vite `?raw` imports for bundled JS library sources (axe-core, web-vitals) that
// we inline into injected page scripts. Mirrors src/sql-raw.d.ts for `*.sql?raw`.
declare module "*.js?raw" {
  const content: string;
  export default content;
}
