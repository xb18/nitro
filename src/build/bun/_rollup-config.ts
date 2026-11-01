import type { BunConfig, Nitro } from "nitro/types";
import type { Plugin } from "rollup";

type RollupLikeConfig = {
  plugins?: unknown;
  external?: unknown;
  output?: {
    entryFileNames?: unknown;
    format?: string;
    inlineDynamicImports?: boolean;
    banner?: unknown;
    footer?: unknown;
  };
};

/**
 * Options of `rollupConfig` and `rolldownConfig` (which takes precedence) supported by the `bun`
 * builder. Presets set them for every builder (e.g. plugins or the entry file name).
 */
export function fromRollupConfig(nitro: Nitro): { config: BunConfig; plugins: Plugin[] } {
  const configs = [nitro.options.rolldownConfig, nitro.options.rollupConfig] as (
    | RollupLikeConfig
    | undefined
  )[];
  const output = (key: keyof NonNullable<RollupLikeConfig["output"]>) =>
    configs.map((config) => config?.output?.[key]).find((value) => value !== undefined);

  const format = output("format") as string | undefined;
  const inlineDynamicImports = output("inlineDynamicImports") ?? nitro.options.inlineDynamicImports;
  const entryFileNames = output("entryFileNames");

  const config: BunConfig = {
    format: format === "iife" ? "iife" : format === "cjs" || format === "commonjs" ? "cjs" : "esm",
    splitting: !inlineDynamicImports && format !== "iife",
  };
  if (typeof entryFileNames === "string") {
    config.naming = { entry: entryFileNames };
  }
  for (const key of ["banner", "footer"] as const) {
    const value = output(key);
    if (typeof value === "string") {
      config[key] = value;
    }
  }

  const plugins = configs.flatMap((config) => flatPlugins(config?.plugins));
  const externals = configs.map((config) => externalPlugin(config?.external)).filter(Boolean);

  return { config, plugins: [...(externals as Plugin[]), ...plugins] };
}

function flatPlugins(plugins: unknown): Plugin[] {
  if (Array.isArray(plugins)) {
    return plugins.flatMap((plugin) => flatPlugins(plugin));
  }
  return plugins && typeof plugins === "object" ? [plugins as Plugin] : [];
}

/** Rollup's `external` option as a plugin (Bun only supports a list of strings). */
function externalPlugin(external: unknown): Plugin | undefined {
  if (!external) {
    return;
  }
  const isExternal =
    typeof external === "function"
      ? (id: string, importer: string | undefined) => !!external(id, importer, false)
      : (id: string) =>
          [external]
            .flat()
            .some((pattern) => (pattern instanceof RegExp ? pattern.test(id) : pattern === id));
  return {
    name: "nitro:external",
    resolveId: {
      order: "pre",
      handler: (id, importer) => (isExternal(id, importer) ? { id, external: true } : undefined),
    },
  };
}
