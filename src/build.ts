import { relative, resolve, join } from 'pathe'
import * as rollup from 'rollup'
import fse from 'fs-extra'
import { watch } from 'chokidar'
import { debounce } from 'perfect-debounce'
import { printFSTree } from './utils/tree'
import { getRollupConfig } from './rollup/config'
import { prettyPath, writeFile, isDirectory, serializeTemplate } from './utils'
import { GLOB_SCAN_PATTERN, scanHandlers } from './scan'
import type { Nitro } from './types'

export async function prepare (nitro: Nitro) {
  await cleanupDir(nitro.options.output.dir)

  if (!nitro.options.output.publicDir.startsWith(nitro.options.output.dir)) {
    await cleanupDir(nitro.options.output.publicDir)
  }

  if (!nitro.options.output.serverDir.startsWith(nitro.options.output.dir)) {
    await cleanupDir(nitro.options.output.serverDir)
  }
}

async function cleanupDir (dir: string) {
  await fse.emptyDir(dir)
}

export async function copyPublicAssets (nitro: Nitro) {
  for (const asset of nitro.options.publicAssets) {
    if (await isDirectory(asset.dir)) {
      await fse.copy(asset.dir, join(nitro.options.output.publicDir, asset.baseURL!))
    }
  }
  nitro.logger.success('Generated public ' + prettyPath(nitro.options.output.publicDir))
}

export async function build (nitro: Nitro) {
  // Compile html template
  const htmlSrc = resolve(nitro.options.buildDir, 'views/app.template.html')
  const htmlTemplate = { src: htmlSrc, contents: '', dst: '' }
  htmlTemplate.dst = htmlTemplate.src.replace(/.html$/, '.mjs').replace('app.template.mjs', 'document.template.mjs')
  htmlTemplate.contents = nitro.vfs[htmlTemplate.src] || await fse.readFile(htmlTemplate.src, 'utf-8').catch(() => '')
  if (htmlTemplate.contents) {
    await nitro.hooks.callHook('nitro:document', htmlTemplate)
    const compiled = 'export default ' + serializeTemplate(htmlTemplate.contents)
    await writeFile(htmlTemplate.dst, compiled)
  }

  nitro.options.rollupConfig = getRollupConfig(nitro)
  await nitro.hooks.callHook('nitro:rollup:before', nitro)
  return nitro.options.dev ? _watch(nitro) : _build(nitro)
}

export async function writeTypes (nitro: Nitro) {
  const routeTypes: Record<string, string[]> = {}

  const middleware = [
    ...nitro.scannedHandlers,
    ...nitro.options.handlers
  ]

  for (const mw of middleware) {
    if (typeof mw.handler !== 'string' || !mw.route) { continue }
    const relativePath = relative(join(nitro.options.buildDir, 'types'), mw.handler).replace(/\.[a-z]+$/, '')
    routeTypes[mw.route] = routeTypes[mw.route] || []
    routeTypes[mw.route].push(`Awaited<ReturnType<typeof import('${relativePath}').default>>`)
  }

  let autoImportedTypes: string[] = []

  if (nitro.unimport) {
    autoImportedTypes = [
      nitro.unimport
        .generateTypeDecarations({ exportHelper: false })
        .trim()
    ]
  }

  const lines = [
    '// Generated by nitro',
    'declare module \'nitropack\' {',
    '  type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T',
    '  interface InternalApi {',
    ...Object.entries(routeTypes).map(([path, types]) => `    '${path}': ${types.join(' | ')}`),
    '  }',
    '}',
    ...autoImportedTypes,
    // Makes this a module for augmentation purposes
    'export {}'
  ]

  await writeFile(join(nitro.options.buildDir, 'types/nitro.d.ts'), lines.join('\n'))
}

async function _build (nitro: Nitro) {
  await scanHandlers(nitro)
  await writeTypes(nitro)

  nitro.logger.start('Building server...')
  const build = await rollup.rollup(nitro.options.rollupConfig).catch((error) => {
    nitro.logger.error('Rollup error: ' + error.message)
    throw error
  })

  nitro.logger.start('Writing server bundle...')
  await build.write(nitro.options.rollupConfig.output)

  // Write build info
  const nitroConfigPath = resolve(nitro.options.output.dir, 'nitro.json')
  const buildInfo = {
    date: new Date(),
    preset: nitro.options.preset,
    commands: {
      preview: nitro.options.commands.preview,
      deploy: nitro.options.commands.deploy
    }
  }
  await writeFile(nitroConfigPath, JSON.stringify(buildInfo, null, 2))

  nitro.logger.success('Server built')
  if (nitro.options.logLevel > 1) {
    await printFSTree(nitro.options.output.serverDir)
  }
  await nitro.hooks.callHook('nitro:compiled', nitro)

  // Show deploy and preview hints
  const rOutput = relative(process.cwd(), nitro.options.output.dir)
  const rewriteRelativePaths = (input: string) => {
    return input.replaceAll(/\s\.\/([^\s]+)/g, ` ${rOutput}/$1`)
  }
  if (buildInfo.commands.preview) {
    nitro.logger.info(`You can preview this build using \`${rewriteRelativePaths(buildInfo.commands.preview)}\``)
  }
  if (buildInfo.commands.deploy) {
    nitro.logger.info(`You can deploy this build using \`${rewriteRelativePaths(buildInfo.commands.deploy)}\``)
  }

  return {
    entry: resolve(nitro.options.rollupConfig.output.dir, nitro.options.rollupConfig.output.entryFileNames as string)
  }
}

function startRollupWatcher (nitro: Nitro) {
  const watcher = rollup.watch(nitro.options.rollupConfig)
  let start: number

  watcher.on('event', (event) => {
    switch (event.code) {
      // The watcher is (re)starting
      case 'START':
        return

      // Building an individual bundle
      case 'BUNDLE_START':
        start = Date.now()
        return

      // Finished building all bundles
      case 'END':
        nitro.hooks.callHook('nitro:compiled', nitro)
        nitro.logger.success('Nitro built', start ? `in ${Date.now() - start} ms` : '')
        nitro.hooks.callHook('nitro:dev:reload')
        return

      // Encountered an error while bundling
      case 'ERROR':
        nitro.logger.error('Rollup error: ', event.error)
    }
  })
  return watcher
}

async function _watch (nitro: Nitro) {
  let rollupWatcher: rollup.RollupWatcher

  const reload = debounce(async () => {
    if (rollupWatcher) { await rollupWatcher.close() }
    await scanHandlers(nitro)
    rollupWatcher = startRollupWatcher(nitro)
    await writeTypes(nitro)
  })

  const watchPatterns = nitro.options.scanDirs.flatMap(dir => [
    join(dir, 'api'),
    join(dir, 'middleware', GLOB_SCAN_PATTERN)
  ])

  const watchReloadEvents = new Set(['add', 'addDir', 'unlink', 'unlinkDir'])
  const reloadWacher = watch(watchPatterns, { ignoreInitial: true }).on('all', (event) => {
    if (watchReloadEvents.has(event)) {
      reload()
    }
  })

  nitro.hooks.hook('close', () => {
    rollupWatcher.close()
    reloadWacher.close()
  })

  await reload()
}
