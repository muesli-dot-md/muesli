// Vite's `?raw` asset imports (docExport.ts inlines the katex stylesheet).
// Declared here rather than via `types: ["vite/client"]` because this package
// deliberately has no vite dependency — the consuming apps' bundlers resolve
// the import; tsc only needs the shape.
declare module "*.css?raw" {
  const css: string;
  export default css;
}
