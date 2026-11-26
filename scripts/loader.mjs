// Lets node load the Worker source as wrangler bundles it: extensionless
// relative imports resolve to .ts, .ts loads with its types stripped
// (node will not strip under node_modules, where a consumer installs
// this package), and .yml files import as text. `install()` registers
// the hooks in this thread.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.endsWith(".yml")) {
    const text = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"));
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}

export function install() {
  // stripTypeScriptTypes warns once that it is experimental.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes("stripTypeScriptTypes")) return;
    emit.call(process, warning, ...rest);
  };
  registerHooks({ resolve, load });
}
