import type { BunConfig, Nitro } from "nitro/types";
import type { Plugin } from "rollup";
import { defu } from "defu";
import alias from "@rollup/plugin-alias";
import inject from "@rollup/plugin-inject";
import { baseBuildConfig } from "../config.ts";
import { baseBuildPlugins, withBuildPlugins } from "../plugins.ts";
import { assetUrls } from "../plugins/asset-urls.ts";
import { builtinExternals } from "../plugins/builtins.ts";
import { PluginContainer } from "./_plugins.ts";
import { fromRollupConfig } from "./_rollup-config.ts";

export async function getBunConfig(
  nitro: Nitro
): Promise<{ config: BunConfig; container: PluginContainer }> {
  const base = await baseBuildConfig(nitro);

  const tsc = nitro.options.typescript.tsConfig?.compilerOptions;

  const rollupConfig = fromRollupConfig(nitro);

  const plugins = (await withBuildPlugins(nitro, [
    ...rollupConfig.plugins,
    // Bun has no `neutral` target: builtins of runtimes without `node` are handled by Nitro
    builtinExternals(base.env, { node: nitro.options.node }),
    ...(await baseBuildPlugins(nitro, base)),
    alias({ entries: base.aliases }),
    Object.keys(base.env.inject).length > 0 &&
      (inject as unknown as typeof inject.default)(base.env.inject),
    // Emitted files are read from the filesystem, which worker runtimes do not have
    nitro.options.node && (await assetUrls(nitro)),
  ])) as (Plugin | false)[];

  const container = new PluginContainer(plugins.filter(Boolean) as Plugin[], {
    rootDir: nitro.options.rootDir,
    conditions: nitro.options.exportConditions!,
    extensions: base.extensions,
    watchMode: nitro.options.dev,
    onWarn: (message) => nitro.logger.warn(message),
  });

  const config: BunConfig = defu(nitro.options.bunConfig, rollupConfig.config, {
    entrypoints: [nitro.options.entry],
    root: nitro.options.rootDir,
    target: nitro.options.preset.includes("bun") ? "bun" : nitro.options.node ? "node" : "browser",
    format: "esm",
    splitting: !nitro.options.inlineDynamicImports,
    external: nitro.options.node ? [...base.env.external] : [],
    conditions: nitro.options.exportConditions,
    naming: {
      entry: "index.mjs",
      chunk: "_chunks/[name]-[hash].mjs",
      asset: "_assets/[name]-[hash].[ext]",
    },
    minify: !!nitro.options.minify,
    sourcemap: nitro.options.sourcemap ? "linked" : "none",
    jsx: {
      runtime: tsc?.jsx === "react" ? "classic" : "automatic",
      factory: tsc?.jsxFactory,
      fragment: tsc?.jsxFragmentFactory,
      importSource: tsc?.jsxImportSource,
      development: nitro.options.dev,
    },
    // `process.env` is read at runtime
    env: "disable",
    metafile: true,
    plugins: [container.bunPlugin()],
  } satisfies BunConfig) as BunConfig;

  return { config, container };
}
