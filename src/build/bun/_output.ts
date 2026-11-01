import type { BunBuildArtifact } from "./_types.ts";
import type { OutputAsset, OutputChunk, OutputOptions, RollupOutput } from "rollup";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "pathe";
import { VIRTUAL_NAMESPACE, type PluginContainer } from "./_plugins.ts";

type OutputBundle = Record<string, OutputChunk | OutputAsset>;

const PRAGMA_RE = /^\/\/ @bun\b.*\n/;

const FILE_URL_RE = /import\.meta\.ROLLUP_FILE_URL_(\w+)/g;

/**
 * Writes the in-memory Bun build output to `dir`, calling the output hooks of the plugins
 * (`renderChunk`, `generateBundle` and `writeBundle`) as Rollup does.
 */
export async function writeOutput(
  container: PluginContainer,
  opts: {
    outputs: BunBuildArtifact[];
    moduleIds: (path: string) => string[];
    dir: string;
    entry: string;
    sourcemap: boolean;
  }
): Promise<RollupOutput> {
  const outputOptions = { dir: opts.dir, format: "es", sourcemap: opts.sourcemap } as OutputOptions;

  const bundle: OutputBundle = {};
  for (const artifact of opts.outputs) {
    const fileName = artifact.path.replace(/^\.\//, "");
    if (artifact.kind === "entry-point" || artifact.kind === "chunk") {
      bundle[fileName] = toChunk(fileName, {
        // Rollup plugins match `\0` ids in the output, which Bun writes as `\x00`
        code: (await artifact.text()).replace(/\\x00(?!\d)/g, "\\0"),
        entry: artifact.kind === "entry-point" ? opts.entry : undefined,
        moduleIds: opts.moduleIds(artifact.path),
      });
    } else {
      const source =
        artifact.kind === "sourcemap"
          ? relocateSources(container, await artifact.text(), dirname(join(opts.dir, fileName)))
          : await artifact.bytes();
      bundle[fileName] = toAsset(fileName, source);
    }
  }

  const emitAssets = () => {
    for (const { fileName, source } of container.emittedFiles.values()) {
      bundle[fileName] ??= toAsset(fileName, source);
    }
  };
  emitAssets();

  const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
  const meta = { chunks: Object.fromEntries(chunks.map((chunk) => [chunk.fileName, chunk])) };
  for (const chunk of chunks) {
    // Bun only reads the pragma of bundled files (e.g. `// @bun`) on the first line
    const pragma = PRAGMA_RE.exec(chunk.code)?.[0] || "";
    chunk.code = await renderFileUrls(container, chunk.code.slice(pragma.length), chunk.fileName);
    chunk.code = await container.renderChunk(chunk.code, [chunk, outputOptions, meta]);
    chunk.code = pragma + chunk.code;
  }

  await container.callBundleHook("generateBundle", [outputOptions, bundle, true]);
  emitAssets();

  await Promise.all(
    Object.values(bundle).map(async (output) => {
      const path = join(opts.dir, output.fileName);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, output.type === "chunk" ? output.code : output.source);
    })
  );

  await container.callBundleHook("writeBundle", [outputOptions, bundle]);

  return { output: Object.values(bundle) } as RollupOutput;
}

/** Renders the references to emitted assets (`import.meta.ROLLUP_FILE_URL_<id>`). */
async function renderFileUrls(
  container: PluginContainer,
  code: string,
  chunkFileName: string
): Promise<string> {
  let rendered = "";
  let index = 0;
  for (const match of code.matchAll(FILE_URL_RE)) {
    const referenceId = match[1]!;
    const file = container.emittedFiles.get(referenceId);
    if (!file) {
      continue;
    }
    let relativePath = relative(dirname(chunkFileName), file.fileName);
    relativePath = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
    const url =
      (await container.resolveFileUrl({
        chunkId: chunkFileName,
        fileName: file.fileName,
        format: "es",
        moduleId: null,
        referenceId,
        relativePath,
      })) || `new URL(${JSON.stringify(relativePath)}, import.meta.url).href`;
    rendered += code.slice(index, match.index) + url;
    index = match.index + match[0].length;
  }
  return rendered + code.slice(index);
}

function toChunk(
  fileName: string,
/**
 * Bun writes the sources of source maps relative to the working directory, and virtual modules
 * in its namespace: they are namespaced as `virtual:<id>` instead (same as `nitro:sourcemap`).
 */
function relocateSources(container: PluginContainer, code: string, dir: string): string {
  const map = JSON.parse(code) as { sources?: string[] };
  map.sources = map.sources?.map((source) => {
    const id = container.moduleId(source);
    if (isAbsolute(id) && !id.includes("\0")) {
      return relative(dir, id);
    }
    if (!source.startsWith(`${VIRTUAL_NAMESPACE}:`)) {
      return source;
    }
    const virtualId = id.replace(/^\0/, "");
    return virtualId.startsWith("virtual:") ? virtualId : `virtual:${virtualId}`;
  });
  return JSON.stringify(map);
}

  opts: { code: string; entry?: string; moduleIds: string[] }
): OutputChunk {
  return {
    type: "chunk",
    fileName,
    preliminaryFileName: fileName,
    name: basename(fileName).replace(/\.[^.]+$/, ""),
    code: opts.code,
    map: null,
    sourcemapFileName: null,
    isEntry: !!opts.entry,
    isDynamicEntry: false,
    isImplicitEntry: false,
    facadeModuleId: opts.entry || null,
    moduleIds: opts.moduleIds,
    modules: {},
    exports: [],
    imports: [],
    dynamicImports: [],
    importedBindings: {},
    implicitlyLoadedBefore: [],
    referencedFiles: [],
  };
}

function toAsset(fileName: string, source: string | Uint8Array): OutputAsset {
  return {
    type: "asset",
    fileName,
    name: undefined,
    names: [],
    originalFileName: null,
    originalFileNames: [],
    source,
    needsCodeReference: false,
  };
}
