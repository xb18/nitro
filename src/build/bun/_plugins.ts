import type { BunLoader as Loader, BunPlugin } from "./_types.ts";
import type { Plugin } from "rollup";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { resolveModulePath } from "exsolve";
import { isAbsolute, join, resolve } from "pathe";
import { importOXC, type OXC } from "../../utils/oxc.ts";
import { pluginContext } from "./_context.ts";
import { rewriteExternalStarExports } from "./_reexports.ts";
import {
  HOOK_NAMES,
  cleanId,
  getHooks,
  isFile,
  matchFilter,
  resolveLoader,
  type Hook,
  type HookName,
} from "./_hooks.ts";

export interface ResolvedModule {
  id: string;
  external: boolean;
  [key: string]: unknown;
}

export interface PluginContainerOptions {
  rootDir: string;
  conditions: string[];
  extensions: string[];
  watchMode: boolean;
  onWarn: (message: string) => void;
}

const VIRTUAL_NAMESPACE = "nitro";

const JS_RE = /\.[cm]?[jt]sx?$/;

const SCRIPT_LOADERS = new Set<string>(["js", "jsx", "ts", "tsx"]);

/**
 * Runs Rollup plugins (`resolveId`, `load` and `transform`) in a Bun plugin.
 *
 * Output hooks (`renderChunk`, `resolveFileUrl`, `generateBundle`, `writeBundle`) are called by
 * `writeOutput` (see `_output.ts`) on the in-memory build result.
 */
export class PluginContainer {
  readonly moduleIds = new Set<string>();
  readonly watchFiles = new Set<string>();
  /** Assets emitted by plugins, by reference id. */
  readonly emittedFiles = new Map<string, { fileName: string; source: string | Uint8Array }>();

  #opts: PluginContainerOptions;
  #hooks: Record<HookName, Hook[]>;
  /** Ids of virtual modules by their (escaped) path in Bun. */
  #virtualPaths = new Map<string, string>();
  #oxc?: OXC;
  #exportNames = new Map<string, Promise<string[]>>();

  constructor(plugins: Plugin[], opts: PluginContainerOptions) {
    this.#opts = opts;
    this.#hooks = Object.fromEntries(
      HOOK_NAMES.map((name) => [name, getHooks(plugins, name)])
    ) as Record<HookName, Hook[]>;
  }

  bunPlugin(): BunPlugin {
    return {
      name: "nitro:plugins",
      setup: (build) => {
        build.onResolve({ filter: /.*/ }, async (args) => {
          const isEntry = args.kind === "entry-point-build";
          const importer = isEntry
            ? undefined
            : this.#virtualPaths.get(args.importer) || args.importer || undefined;
          const resolved =
            (await this.resolveId(args.path, importer, { kind: args.kind, isEntry })) ||
            // Bun resolves imports of virtual modules relative to their id (not a directory)
            (this.#virtualPaths.has(args.importer)
              ? this.defaultResolve(args.path, importer)
              : undefined);
          if (!resolved) {
            return;
          }
          if (resolved.external) {
            return { path: resolved.id, external: true };
          }
          // Bun rejects file paths containing `..` (e.g. `[...slug].ts`): they are loaded as virtual modules
          if (isFile(resolved.id) && !resolved.id.includes("..")) {
            return { path: resolved.id };
          }
          // Bun writes module paths to the output (comments): `\0` is escaped
          const path = resolved.id.replaceAll("\0", "\\0");
          this.#virtualPaths.set(path, resolved.id);
          return { path, namespace: VIRTUAL_NAMESPACE };
        });
        build.onLoad({ filter: /.*/, namespace: VIRTUAL_NAMESPACE }, async (args) => {
          const id = this.#virtualPaths.get(args.path) || args.path;
          const result = await this.load(id, { read: true });
          if (!result) {
            throw new Error(`Could not load virtual module \`${id}\`.`);
          }
          return result;
        });
        build.onLoad({ filter: /.*/ }, (args) => this.load(args.path, { loader: args.loader }));
      },
    };
  }

  async buildStart() {
    this.moduleIds.clear();
    this.emittedFiles.clear();
    // `this.parse` is synchronous
    this.#oxc ??= await importOXC({ dir: this.#opts.rootDir });
    await Promise.all(this.#hooks.buildStart.map((hook) => this.#call(hook, [{}])));
  }

  async buildEnd(error?: unknown) {
    await Promise.all(this.#hooks.buildEnd.map((hook) => this.#call(hook, [error])));
  }

  /** Calls the `renderChunk` hooks in order, each with the code returned by the previous one. */
  async renderChunk(code: string, args: unknown[]): Promise<string> {
    for (const hook of this.#hooks.renderChunk) {
      const result = await this.#call(hook, [code, ...args]);
      if (result != null) {
        code = typeof result === "string" ? result : result.code;
      }
    }
    return code;
  }

  /** Calls the `generateBundle` or `writeBundle` hook of each plugin in order. */
  async callBundleHook(name: "generateBundle" | "writeBundle", args: unknown[]) {
    for (const hook of this.#hooks[name]) {
      await this.#call(hook, args);
    }
  }

  /** Result of the first `resolveFileUrl` hook returning one. */
  async resolveFileUrl(args: Record<string, unknown>): Promise<string | undefined> {
    for (const hook of this.#hooks.resolveFileUrl) {
      const result = await this.#call(hook, [args]);
      if (result != null) {
        return result;
      }
    }
  }

  /** Module id of an input of the Bun metafile (relative to the working directory). */
  moduleId(input: string): string {
    if (input.startsWith(`${VIRTUAL_NAMESPACE}:`)) {
      const path = input.slice(VIRTUAL_NAMESPACE.length + 1);
      return this.#virtualPaths.get(path) || path;
    }
    return isAbsolute(input) || /^[a-z]{2,}:/.test(input) ? input : resolve(input);
  }

  /** Runs `resolveId` hooks, or returns `undefined` when none resolves `id`. */
  async resolveId(
    id: string,
    importer: string | undefined,
    opts: { kind?: string; isEntry?: boolean; custom?: unknown; skip?: Set<Plugin> } = {}
  ): Promise<ResolvedModule | undefined> {
    for (const hook of this.#hooks.resolveId) {
      if (opts.skip?.has(hook.plugin) || !matchFilter(hook.filter?.id, { id })) {
        continue;
      }
      const result = await this.#call(
        hook,
        [
          id,
          importer,
          { attributes: {}, custom: opts.custom, isEntry: !!opts.isEntry, kind: opts.kind },
        ],
        { skip: opts.skip }
      );
      if (result == null) {
        continue;
      }
      if (result === false) {
        return { id, external: true };
      }
      return typeof result === "string"
        ? { id: result, external: false }
        : { ...result, external: !!result.external };
    }
  }

  defaultResolve(id: string, importer: string | undefined): ResolvedModule | undefined {
    if (isBuiltin(id)) {
      return { id: id.includes(":") ? id : `node:${id}`, external: true };
    }
    const from = importer && isFile(importer) ? importer : join(this.#opts.rootDir, "_index.js");
    const path = resolveModulePath(id, {
      from,
      conditions: this.#opts.conditions,
      extensions: this.#opts.extensions,
      try: true,
    });
    return path ? { id: path, external: false } : undefined;
  }

  /** Runs `load` and `transform` hooks, or returns `undefined` to let Bun load the file. */
  async load(
    id: string,
    opts: { loader?: Loader; read?: boolean } = {}
  ): Promise<{ contents: string; loader: Loader } | undefined> {
    this.moduleIds.add(id);
    const isJS = JS_RE.test(cleanId(id));
    let code: string | undefined;
    let moduleType: string | undefined;
    for (const hook of this.#hooks.load) {
      if (!matchFilter(hook.filter?.id, { id })) {
        continue;
      }
      const result = await this.#call(hook, [id], { id });
      if (result != null) {
        code = typeof result === "string" ? result : result.code;
        moduleType = result.moduleType;
        break;
      }
    }
    const loaded = code !== undefined;
    if (!loaded) {
      const path = cleanId(id);
      // Files no `transform` hook applies to are loaded by Bun (with its own loader)
      const hasTransforms = this.#hooks.transform.some(
        (hook) => isJS || (hook.filter?.id && matchFilter(hook.filter.id, { id }))
      );
      if (!isFile(path) || !(hasTransforms || opts.read)) {
        return;
      }
      code = await readFile(path, "utf8");
    }
    let transformed = false;
    for (const hook of this.#hooks.transform) {
      // Other files only by explicit `id` filters (Bun has its own loaders for them)
      if (!isJS && !loaded && !hook.filter?.id) {
        continue;
      }
      if (
        !matchFilter(hook.filter?.id, { id }) ||
        !matchFilter(hook.filter?.code, { code: code! })
      ) {
        continue;
      }
      const result = await this.#call(hook, [code, id, { moduleType: moduleType || "js" }], {
        id,
      });
      if (result == null) {
        continue;
      }
      transformed = true;
      code = typeof result === "string" ? result : (result.code ?? code);
      moduleType = result.moduleType || moduleType;
    }
    const loader = resolveLoader(id, {
      moduleType,
      // Unchanged files keep Bun's loader (or a JSON file read for a virtual module)
      fallback:
        loaded || transformed
          ? "js"
          : opts.loader || (cleanId(id).endsWith(".json") ? "json" : "js"),
    });
    if (SCRIPT_LOADERS.has(loader)) {
      code =
        (await rewriteExternalStarExports(code!, {
          id,
          oxc: this.#oxc!,
          names: this.#exportNames,
          onWarn: this.#opts.onWarn,
          resolveExternal: async (specifier) => {
            const resolved = await this.resolveId(specifier, id);
            if (resolved?.external) {
              // Ids of externals can be placeholders (e.g. traced dependencies)
              return this.defaultResolve(specifier, id)?.id || resolved.id;
            }
          },
        })) || code;
    }
    return { contents: code!, loader };
  }

  #call(hook: Hook, args: unknown[], opts: { skip?: Set<Plugin>; id?: string } = {}) {
    const context = pluginContext(this, {
      plugin: hook.plugin,
      skip: opts.skip,
      id: opts.id,
      oxc: this.#oxc,
      watchMode: this.#opts.watchMode,
      onWarn: this.#opts.onWarn,
    });
    return hook.handler.call(context, ...args);
  }
}
