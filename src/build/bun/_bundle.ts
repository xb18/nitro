import type { BunConfig, Nitro } from "nitro/types";
import type { RollupOutput } from "rollup";
import { writeOutput } from "./_output.ts";
import { isFile } from "./_hooks.ts";
import type { PluginContainer } from "./_plugins.ts";
import type { BunBuildMessage, BunBuildOutput } from "./_types.ts";

/** Bundles with `Bun.build` and writes the output to the server dir. */
export async function bundle(
  nitro: Nitro,
  config: BunConfig,
  container: PluginContainer
): Promise<{ output: RollupOutput; inputs: string[] }> {
  await container.buildStart();
  let result: BunBuildOutput;
  try {
    result = await getBun().build({ ...config, throw: false });
    if (!result.success) {
      throw new AggregateError(
        result.logs,
        `Build failed:\n${result.logs.map((log) => formatLog(log)).join("\n")}`
      );
    }
  } catch (error) {
    await container.buildEnd(error);
    throw error;
  }
  await container.buildEnd();

  for (const log of result.logs) {
    nitro.logger.warn(formatLog(log));
  }

  const toModuleIds = (inputs: Record<string, unknown> = {}) =>
    Object.keys(inputs).map((input) => container.moduleId(input));

  const output = await writeOutput(container, {
    outputs: result.outputs,
    moduleIds: (path) => toModuleIds(result.metafile?.outputs[path]?.inputs),
    dir: nitro.options.output.serverDir,
    entry: nitro.options.entry,
    sourcemap: !!nitro.options.sourcemap,
  });

  const inputs = [...toModuleIds(result.metafile?.inputs), ...container.watchFiles];
  return { output, inputs: inputs.filter((id) => isFile(id)) };
}

export function assertBunRuntime() {
  if (!process.versions.bun) {
    throw new Error(
      "The `bun` builder requires the Bun runtime. Run Nitro with Bun (e.g. `bun --bun nitro build`) or use another builder."
    );
  }
}

function getBun() {
  return (globalThis as any).Bun as { build: (config: BunConfig) => Promise<BunBuildOutput> };
}

function formatLog(log: BunBuildMessage): string {
  const position = log.position;
  return position
    ? `${log.message}\n    at ${position.file}:${position.line}:${position.column}`
    : log.message;
}
