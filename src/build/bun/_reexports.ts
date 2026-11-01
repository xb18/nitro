import type * as ESTree from "oxbox";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";
import { isAbsolute } from "pathe";
import type { OXC } from "../../utils/oxc.ts";

const STAR_EXPORT_RE = /export\s*\*\s*from/;

const JS_RE = /\.[cm]?[jt]sx?$/;

const IDENTIFIER_RE = /^[$A-Z_a-z][\w$]*$/;

/**
 * Rewrites `export * from "<external>"` to named re-exports (or a side effect import).
 *
 * Bun does not import the namespace of an external module re-exported with `export *`
 * (https://github.com/oven-sh/bun/issues/15997). Names are read from the module itself.
 */
export async function rewriteExternalStarExports(
  code: string,
  opts: {
    id: string;
    oxc: OXC;
    /** Module to import for the names, when `specifier` is external. */
    resolveExternal: (specifier: string) => Promise<string | undefined>;
    names: Map<string, Promise<string[]>>;
    onWarn: (message: string) => void;
  }
): Promise<string | undefined> {
  if (!STAR_EXPORT_RE.test(code)) {
    return;
  }
  const filename = opts.id.split("?")[0]!;
  const { program } = opts.oxc.parseSync(JS_RE.test(filename) ? filename : "module.js", code);
  const stars = program.body.filter(
    (node): node is ESTree.ExportAllDeclaration =>
      node.type === "ExportAllDeclaration" && !node.exported && node.exportKind !== "type"
  );
  if (stars.length === 0) {
    return;
  }

  // Local exports take precedence over star exports
  const exported = new Set(localExportNames(program));
  const s = new MagicString(code);
  for (const node of stars) {
    const specifier = node.source.value;
    const external = await opts.resolveExternal(specifier);
    if (!external) {
      continue;
    }
    let names = opts.names.get(external);
    if (!names) {
      names = import(isAbsolute(external) ? pathToFileURL(external).href : external).then((mod) =>
        Object.keys(mod)
      );
      opts.names.set(external, names);
    }
    const reexports = await names.then(
      (names) => names.filter((name) => name !== "default" && !exported.has(name)),
      (error: unknown) => {
        opts.onWarn(
          `Could not read the exports of \`${specifier}\` (re-exported by \`${filename}\`): ${error}`
        );
      }
    );
    if (!reexports) {
      continue;
    }
    for (const name of reexports) {
      exported.add(name);
    }
    s.overwrite(
      node.start,
      node.end,
      reexports.length > 0
        ? `export { ${reexports.map((name) => (IDENTIFIER_RE.test(name) ? name : JSON.stringify(name))).join(", ")} } from ${JSON.stringify(specifier)};`
        : `import ${JSON.stringify(specifier)};`
    );
  }
  return s.hasChanged() ? s.toString() : undefined;
}

function localExportNames(program: ESTree.Program): string[] {
  const names: string[] = [];
  for (const node of program.body) {
    if (node.type === "ExportDefaultDeclaration") {
      names.push("default");
    } else if (node.type === "ExportAllDeclaration" && node.exported) {
      names.push(moduleExportName(node.exported));
    } else if (node.type === "ExportNamedDeclaration") {
      for (const specifier of node.specifiers) {
        names.push(moduleExportName(specifier.exported));
      }
      const declaration = node.declaration;
      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === "Identifier") {
            names.push(declarator.id.name);
          }
        }
      } else if (declaration && "id" in declaration && declaration.id?.type === "Identifier") {
        names.push(declaration.id.name);
      }
    }
  }
  return names;
}

function moduleExportName(node: ESTree.ModuleExportName): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}
