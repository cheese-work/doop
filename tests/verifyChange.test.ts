import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* .claude/skills/verify-change/verify.sh picks what to run from a diff. VERIFY_PLAN=1 prints that
   selection and stops, so these tests drive it against a throwaway repo instead of running the gates. */
/* assembled so this file does not itself match the script's search for browser tests */
const BROWSER_IMPORT = `import p from 'pup${'peteer'}-core'`
const script = resolve('.claude/skills/verify-change/verify.sh')

let repo: string
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } })
const write = (file: string, body: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), body)
}
const commit = (msg: string) => {
  sh('git', ['add', '-A'])
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg, '--no-verify'])
}
const plan = (env: NodeJS.ProcessEnv = {}) => {
  const out = sh('bash', [script, 'main'], { VERIFY_PLAN: '1', ...env })
  const line = (key: string) =>
    out
      .match(new RegExp(`^plan ${key}: ?(.*)$`, 'm'))?.[1]
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  return {
    related: line('related') ?? [],
    browser: line('browser') ?? [],
    incomplete: line('browser-incomplete')?.[0],
  }
}

/* every case spawns git and bash, which crawl on a loaded shared host */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'verify-change-'))
  sh('git', ['init', '-q', '-b', 'main'])
  write('src/kept.ts', 'export const kept = 1\n')
  write('src/gone.ts', 'export const gone = 1\n')
  write('tests/gone.test.ts', "import { gone } from '../src/gone.ts'\n")
  write('tests/kept.test.ts', "import { kept } from '../src/kept.ts'\n")
  write('tests/keptBrowser.test.ts', `${BROWSER_IMPORT}\nimport { kept } from '../src/kept.ts'\n`)
  write('tests/otherBrowser.test.ts', `${BROWSER_IMPORT}\n`)
  commit('base')
  sh('git', ['switch', '-q', '-c', 'work'])
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('verify-change plan', () => {
  it('selects the importers of a deleted module instead of exiting on a deletion-only diff', () => {
    sh('git', ['rm', '-q', 'src/gone.ts'])
    commit('delete gone')
    expect(plan().related).toContain('tests/gone.test.ts')
  })

  it('still selects the importers of a deleted module when an unrelated file also changed', () => {
    sh('git', ['rm', '-q', 'src/gone.ts'])
    write('src/kept.ts', 'export const kept = 2\n')
    commit('delete gone, edit kept')
    expect(plan().related).toEqual(expect.arrayContaining(['tests/gone.test.ts', 'src/kept.ts']))
  })

  it('runs a browser test that the diff changes or that imports a changed module, and no other', () => {
    write('src/kept.ts', 'export const kept = 2\n')
    write('tests/otherBrowser.test.ts', `${BROWSER_IMPORT}\n// changed\n`)
    commit('edit')
    expect(plan().browser.sort()).toEqual(['tests/keptBrowser.test.ts', 'tests/otherBrowser.test.ts'])
  })

  it('keeps browser files out of the parallel pass', () => {
    write('src/kept.ts', 'export const kept = 2\n')
    commit('edit')
    expect(plan().related.filter((f) => f.endsWith('Browser.test.ts'))).toEqual([])
  })

  it('reports browser coverage incomplete when src/ changed and browser files went unrun', () => {
    write('src/kept.ts', 'export const kept = 2\n')
    commit('edit')
    expect(plan().incomplete).toBe('yes')
  })

  it('runs every browser file with VERIFY_BROWSER=all and then reports complete', () => {
    write('src/kept.ts', 'export const kept = 2\n')
    commit('edit')
    const all = plan({ VERIFY_BROWSER: 'all' })
    expect(all.browser.sort()).toEqual(['tests/keptBrowser.test.ts', 'tests/otherBrowser.test.ts'])
    expect(all.incomplete).toBe('no')
  })
})
