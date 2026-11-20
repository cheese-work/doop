// Route groups of the doop server (CHE-5474 S4c, C-8.5c). A group is `/api/<name>`, or the first path
// segment for anything outside `/api`. `deploy/cd/smoke-routes.json` must list every group; a CI test fails
// when one is missing, or when a listed group no longer exists.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The Gemini cloud worker is its own process with its own `app`; its routes are not the server's.
const SEPARATE_PROCESS = new Set(['geminiCloudWorker.ts'])
const CALL = /\bapp\.(?:get|post|put|patch|delete|all|use)\(\s*(?:\[\s*)?(['"`])(\/[^'"`]*)\1/g

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.ts') && !SEPARATE_PROCESS.has(name) ? [p] : []
  })

export function groupOf(path) {
  const seg = path.split('/').filter(Boolean)
  if (seg[0] === 'api' && seg[1]) return `/api/${seg[1]}`
  return `/${seg[0] ?? ''}`
}

export function routeGroups(serverDir = 'server') {
  const groups = new Set()
  for (const file of walk(serverDir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(CALL)) groups.add(groupOf(m[2]))
  }
  return [...groups].sort()
}

const listed = (routes) => new Set((routes?.groups ?? []).map((g) => g.group))

/** Server groups the smoke list does not name. */
export const missingGroups = (routes, groups) => groups.filter((g) => !listed(routes).has(g))
/** Listed groups the server no longer mounts. */
export const staleGroups = (routes, groups) => [...listed(routes)].filter((g) => !groups.includes(g))
