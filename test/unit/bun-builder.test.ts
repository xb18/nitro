import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Nitro } from "nitro/types";
import { PluginContainer } from "../../src/build/bun/_plugins.ts";
import { fromRollupConfig } from "../../src/build/bun/_rollup-config.ts";

describe.runIf(process.versions.bun)("bun builder plugin container", () => {
  let rootDir: string;

  const files: Record<string, string> = {
    "lib/utils/index.ts": "export const u = 1;",
    "routes/sub/v.ts": "export const v = 1;",
    "routes/[...slug]/image.png": "\u0089PNG",
    "node_modules/esm-pkg/package.json": JSON.stringify({
      name: "esm-pkg",
      type: "module",
      exports: "./index.js",
    }),
    "node_modules/esm-pkg/index.js": "export const a = 1; export const b = 2;",
    "node_modules/cjs-pkg/package.json": JSON.stringify({ name: "cjs-pkg" }),
    "node_modules/cjs-pkg/index.js": `for (const k of ["foo", "bar"]) exports[k] = 1;`,
    "node_modules/cond-pkg/package.json": JSON.stringify({
      name: "cond-pkg",
      exports: { import: "./index.mjs", require: "./index.cjs" },
    }),
    "node_modules/cond-pkg/index.mjs": "export default 1;",
    "node_modules/cond-pkg/index.cjs": "module.exports = 1;",
  };

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "nitro-bun-builder-"));
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(rootDir, path)), { recursive: true });
      await writeFile(join(rootDir, path), contents);
    }
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function createContainer(opts: { external?: string[] } = {}) {
    const container = new PluginContainer(
      [
        {
          name: "test:external",
          resolveId: {
            filter: { id: /^(?:esm|cjs)-pkg$/ },
            handler: (id) => ({ id, external: true }),
          },
        },
      ],
      {
        rootDir,
        conditions: ["node"],
        extensions: [".ts", ".mjs", ".js"],
        isExternal: (id) => !!opts.external?.includes(id),
        watchMode: false,
        onWarn: () => {},
      }
    );
    await container.buildStart();
    return container;
  }

  it("resolves directories to their index file", async () => {
    const container = await createContainer();
    expect(container.defaultResolve(join(rootDir, "lib/utils"), undefined)?.id).toBe(
      join(rootDir, "lib/utils/index.ts")
    );
  });

  it("resolves relative imports of modules with a query from their directory", async () => {
    const container = await createContainer();
    const importer = join(rootDir, "routes/q.ts?inline");
    expect(container.defaultResolve("./sub/v.ts", importer)?.id).toBe(
      join(rootDir, "routes/sub/v.ts")
    );
  });

  it("resolves packages with `import` and `require` conditions", async () => {
    const container = await createContainer();
    expect(container.defaultResolve("cond-pkg", undefined)?.id).toBe(
      join(rootDir, "node_modules/cond-pkg/index.mjs")
    );
    expect(container.defaultResolve("cond-pkg", undefined, { kind: "require-call" })?.id).toBe(
      join(rootDir, "node_modules/cond-pkg/index.cjs")
    );
  });

  async function loadCode(code: string, opts: { external?: string[] } = {}) {
    const container = await createContainer(opts);
    const id = join(rootDir, "virtual-entry.ts");
    container.virtualPaths.set(id, id);
    await writeFile(id, code);
    return (await container.load(id, { read: true }))?.contents;
  }

  it("rewrites `export *` of builtins", async () => {
    const code = await loadCode(`export * from "node:path";`);
    expect(code).toMatch(/^export \{ .*\bjoin\b.* \} from "node:path";$/);
  });

  it("rewrites `export *` of externals of the Bun config", async () => {
    const code = await loadCode(`export * from "cond-pkg";`, { external: ["cond-pkg"] });
    expect(code).toBe(`import "cond-pkg";`);
  });

  it("rewrites `export *` of CommonJS externals from `module.exports`", async () => {
    const code = await loadCode(`export * from "cjs-pkg";`);
    expect(code).toContain(`import __nitro_cjs_0 from "cjs-pkg";`);
    expect(code).toContain(`export { __nitro_cjs_0_0 as`);
    expect(code).not.toMatch(/export \{ [^}]*\} from "cjs-pkg"/);
  });

  it("keeps the names of type-only local exports", async () => {
    const code = await loadCode(
      `export * from "esm-pkg"; export type a = string; export declare const b: number;`
    );
    expect(code).toContain(`export { a, b } from "esm-pkg";`);
  });

  it("loads files of virtual modules other than scripts as bytes", async () => {
    const container = await createContainer();
    const result = await container.load(join(rootDir, "routes/[...slug]/image.png"), {
      read: true,
    });
    expect(result?.loader).toBe("file");
    expect(result?.contents).toBeInstanceOf(Uint8Array);
  });

  it("matches global RegExps of `external` for every id", async () => {
    const { plugins } = await fromRollupConfig({
      options: { rollupConfig: { external: /^ext-/g }, inlineDynamicImports: false },
    } as unknown as Nitro);
    const resolveId = (plugins[0]!.resolveId as { handler: (id: string) => unknown }).handler;
    expect(resolveId("ext-a")).toEqual({ id: "ext-a", external: true });
    expect(resolveId("ext-b")).toEqual({ id: "ext-b", external: true });
  });

  it("does not parse relative `export *`", async () => {
    const code = await loadCode(`export * from "./lib/utils/index.ts";`);
    expect(code).toBe(`export * from "./lib/utils/index.ts";`);
  });
});
