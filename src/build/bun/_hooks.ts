import type { Plugin } from "rollup";
import type { BunLoader } from "./_types.ts";
import { existsSync } from "node:fs";
import { isAbsolute } from "pathe";

export const HOOK_NAMES = [
  "buildStart",
  "resolveId",
  "load",
  "transform",
  "buildEnd",
  "renderChunk",
  "resolveFileUrl",
  "generateBundle",
  "writeBundle",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export interface Hook {
  plugin: Plugin;
  handler: (this: any, ...args: any[]) => any;
  filter?: { id?: StringFilter; code?: StringFilter };
}

type StringFilter = MaybeArray<string | RegExp> | { include?: unknown; exclude?: unknown };

type MaybeArray<T> = T | T[];

const LOADERS = new Set<string>(["js", "jsx", "ts", "tsx", "json", "text", "css"]);

/** Hooks of the plugins named `name`, sorted by `order`. */
export function getHooks(plugins: Plugin[], name: HookName): Hook[] {
  const rank = (order: unknown) => (order === "pre" ? 0 : order === "post" ? 2 : 1);
  return plugins
    .flatMap((plugin) => {
      const hook = plugin[name] as any;
      const handler = typeof hook === "function" ? hook : hook?.handler;
      if (typeof handler !== "function") {
        return [];
      }
      // Composable filters (arrays) are not supported: handlers check their inputs too
      const filter = hook.filter && !Array.isArray(hook.filter) ? hook.filter : undefined;
      return [{ plugin, handler, filter, order: rank(hook.order) }];
    })
    .sort((a, b) => a.order - b.order);
}

/** Whether `value` matches a hook filter (string patterns are matched exactly). */
export function matchFilter(filter: StringFilter | undefined, value: string): boolean {
  if (!filter) {
    return true;
  }
  const { include, exclude } = (
    typeof filter === "string" || filter instanceof RegExp || Array.isArray(filter)
      ? { include: filter }
      : filter
  ) as { include?: MaybeArray<string | RegExp>; exclude?: MaybeArray<string | RegExp> };
  const test = (pattern: string | RegExp) => {
    if (typeof pattern === "string") {
      return pattern === value;
    }
    pattern.lastIndex = 0;
    return pattern.test(value);
  };
  if (exclude && [exclude].flat().some(test)) {
    return false;
  }
  return !include || [include].flat().some(test);
}

export function isFile(id: string): boolean {
  return isAbsolute(id) && !/[\0?]/.test(id) && existsSync(id);
}

export function cleanId(id: string): string {
  return id.split("?")[0]!;
}

export function resolveLoader(
  id: string,
  opts: { moduleType?: string; fallback: BunLoader }
): BunLoader {
  if (opts.moduleType && LOADERS.has(opts.moduleType)) {
    return opts.moduleType as BunLoader;
  }
  const ext = /\.[cm]?(tsx?|jsx)$/.exec(cleanId(id))?.[1];
  if (ext) {
    return ext as BunLoader;
  }
  return opts.fallback;
}
