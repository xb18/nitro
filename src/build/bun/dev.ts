import type { BunConfig, Nitro } from "nitro/types";
import { basename, join } from "pathe";
import { debounce } from "perfect-debounce";
import { formatCompatibilityDate } from "compatx";
import { scanHandlers } from "../../scan.ts";
import { createWatcher } from "../../utils/watch.ts";
import type { PluginContainer } from "./_plugins.ts";
import { bundle } from "./_bundle.ts";

export async function watchDev(nitro: Nitro, config: BunConfig, container: PluginContainer) {
  // `Bun.build` has no watch mode: modules of the last build are watched to rebuild
  const watchedFiles = new Set<string>();
  const modulesWatcher = createWatcher(nitro, [], { ignoreInitial: true }).on("all", (event) => {
    if (event === "change" || event === "unlink") {
      rebuild();
    }
  });
  const watch = (files: string[]) => {
    files = files.filter((file) => !file.includes("node_modules") && !watchedFiles.has(file));
    for (const file of files) {
      watchedFiles.add(file);
    }
    if (files.length > 0) {
      modulesWatcher.add(files);
    }
  };

  const rebuild = debounce(async () => {
    const start = Date.now();
    await nitro.hooks.callHook("dev:start");
    try {
      const { inputs } = await bundle(nitro, config, container);
      watch(inputs);
      await nitro.hooks.callHook("compiled", nitro);
      if (nitro.options.logging.buildSuccess) {
        nitro.logger.success(`Server built in ${Date.now() - start}ms`);
      }
      await nitro.hooks.callHook("dev:reload");
    } catch (error) {
      // Files with errors may not be part of the last successful build (e.g. a new import)
      watch(errorFiles(error));
      nitro.logger.error(error);
      await nitro.hooks.callHook("dev:error", error);
    }
  });

  const reload = debounce(async () => {
    await scanHandlers(nitro);
    nitro.routing.sync();
    await rebuild();
  });

  const scanDirs = nitro.options.scanDirs.flatMap((dir) => [
    join(dir, nitro.options.apiDir || "api"),
    join(dir, nitro.options.routesDir || "routes"),
    join(dir, "middleware"),
    join(dir, "plugins"),
    join(dir, "modules"),
  ]);

  const watchReloadEvents = new Set(["add", "addDir", "unlink", "unlinkDir"]);
  const scanDirsWatcher = createWatcher(nitro, scanDirs, {
    ignoreInitial: true,
  }).on("all", (event) => {
    if (watchReloadEvents.has(event)) {
      reload();
    } else if (event === "change") {
      // Files of a failed first build are not watched yet
      rebuild();
    }
  });

  const serverEntryRe = /^server\.[mc]?[jt]sx?$/;
  const rootDirWatcher = createWatcher(nitro, nitro.options.rootDir, {
    ignoreInitial: true,
    depth: 0,
  }).on("all", (event, path) => {
    if (watchReloadEvents.has(event) && serverEntryRe.test(basename(path))) {
      reload();
    }
  });

  nitro.hooks.hook("close", () => {
    modulesWatcher.close();
    scanDirsWatcher.close();
    rootDirWatcher.close();
  });

  nitro.hooks.hook("build:reload", () => reload());

  nitro.logger.info(
    `Starting dev watcher (builder: \`bun\`, preset: \`${nitro.options.preset}\`, compatibility date: \`${formatCompatibilityDate(nitro.options.compatibilityDate)}\`)`
  );

  await reload();
}

function errorFiles(error: unknown): string[] {
  const logs = (error as { errors?: { position?: { file?: string } | null }[] })?.errors || [];
  return logs.flatMap((log) => (log?.position?.file ? [log.position.file] : []));
}
