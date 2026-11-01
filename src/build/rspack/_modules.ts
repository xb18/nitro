import type { Compilation, Module } from "@rspack/core";

/** Minimal Rollup `ModuleInfo` (`this.getModuleInfo`). */
export interface ModuleInfo {
  id: string;
  isEntry: boolean;
  isExternal: boolean;
  importers: string[];
  importedIds: string[];
  dynamicImporters: string[];
  dynamicallyImportedIds: string[];
  meta: Record<string, unknown>;
}

/** Plugin id of a module (`undefined` for modules without resource, such as externals). */
export function moduleId(
  module: Module | null | undefined,
  toId: (resource: string) => string
): string | undefined {
  const resource = (module as { resource?: string } | null | undefined)?.resource;
  return resource ? toId(resource) : undefined;
}

/** Info of a module of the compilation (from its module graph connections). */
export function getModuleInfo(
  compilation: Compilation,
  id: string,
  toId: (resource: string) => string
): ModuleInfo | null {
  const module = findModule(compilation, id, toId);
  if (!module) {
    return null;
  }
  const { moduleGraph } = compilation;
  const info: ModuleInfo = {
    id,
    isEntry: false,
    isExternal: false,
    importers: [],
    importedIds: [],
    dynamicImporters: [],
    dynamicallyImportedIds: [],
    meta: {},
  };
  for (const connection of moduleGraph.getIncomingConnections(module)) {
    const importer = moduleId(connection.originModule, toId);
    if (!connection.originModule) {
      info.isEntry ||= connection.dependency.type === "entry";
    } else if (importer) {
      addUnique(isDynamic(connection) ? info.dynamicImporters : info.importers, importer);
    }
  }
  for (const connection of moduleGraph.getOutgoingConnections(module)) {
    const imported = moduleId(connection.module, toId);
    if (imported) {
      addUnique(isDynamic(connection) ? info.dynamicallyImportedIds : info.importedIds, imported);
    }
  }
  return info;
}

const moduleIndexes = new WeakMap<Compilation, { size: number; modules: Map<string, Module> }>();

/** Module of a compilation by id (indexed again on a miss, if modules were added since). */
function findModule(
  compilation: Compilation,
  id: string,
  toId: (resource: string) => string
): Module | undefined {
  let index = moduleIndexes.get(compilation);
  const module = index?.modules.get(id);
  if (module || index?.size === compilation.modules.size) {
    return module;
  }
  index = { size: compilation.modules.size, modules: new Map() };
  for (const m of compilation.modules) {
    const mid = moduleId(m, toId);
    if (mid && !index.modules.has(mid)) {
      index.modules.set(mid, m);
    }
  }
  moduleIndexes.set(compilation, index);
  return index.modules.get(id);
}

function isDynamic(connection: { dependency: { type: string } }): boolean {
  return connection.dependency.type === "import()";
}

function addUnique(list: string[], value: string) {
  if (!list.includes(value)) {
    list.push(value);
  }
}
