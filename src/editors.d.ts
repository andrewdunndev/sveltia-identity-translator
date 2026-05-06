// Type declarations for text-imported files.
//
// wrangler bundles .yml files as text via a top-level [[rules]] block
// in wrangler.toml. The TS compiler doesn't know about that and would
// otherwise error on `import yaml from "../editors.yml"`. This module
// declaration tells it the import returns a string.

declare module "*.yml" {
  const content: string;
  export default content;
}
