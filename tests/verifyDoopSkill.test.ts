import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/* .claude/skills/verify-doop drives the real app. These tests pin the parts an agent reads cold: the skill
   body, the helpers it promises, the feature map index, and the one safety property of cleanup (it kills
   only what launch started, never a process it merely finds by pid). The live run is the proof of the rest. */
const root = resolve('.claude/skills/verify-doop')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const run = (rel: string, args: string[] = []) => spawnSync('bash', [join(root, rel), ...args], { encoding: 'utf8' })

describe('verify-doop skill body', () => {
  it('registers under its own name', () => {
    expect(read('SKILL.md')).toMatch(/^---\nname: verify-doop\ndescription: .+\n---\n/)
  })

  it('has the five verification sections', () => {
    const body = read('SKILL.md')
    for (const h of ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup'])
      expect(body).toMatch(new RegExp(`^## ${h}$`, 'm'))
  })

  it('ships every helper it names, executable', () => {
    const body = read('SKILL.md')
    const named = [...body.matchAll(/\.claude\/skills\/verify-doop\/(scripts\/[\w.-]+)/g)].map((m) => m[1]!)
    expect(new Set(named)).toEqual(
      new Set(['scripts/launch.sh', 'scripts/doctor.sh', 'scripts/cleanup.sh', 'scripts/drive.mjs']),
    )
    for (const rel of named) accessSync(join(root, rel), constants.X_OK)
  })
})

describe('verify-doop feature map', () => {
  it('indexes every feature file and links no dead file', () => {
    const readme = read('features/README.md')
    const files = readdirSync(join(root, 'features')).filter((f) => f !== 'README.md')
    expect(files.length).toBeGreaterThanOrEqual(3)
    const linked = [...readme.matchAll(/\]\(([\w-]+\.md)\)/g)].map((m) => m[1]!)
    expect(new Set(linked)).toEqual(new Set(files))
  })

  it('gives each feature the four sections', () => {
    for (const f of readdirSync(join(root, 'features')).filter((f) => f !== 'README.md')) {
      const body = read(`features/${f}`)
      for (const h of ['Sub-features', 'How to get to it (user POV)', 'Driving it with', 'Gotchas'])
        expect(body, `${f}: ${h}`).toContain(`## ${h}`)
    }
  })
})

describe('verify-doop helpers', () => {
  const dirs: string[] = []
  const children: { kill: () => boolean }[] = []
  afterEach(() => {
    for (const c of children.splice(0)) c.kill()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('doctor and cleanup refuse to run without a run directory', () => {
    expect(run('scripts/doctor.sh').status).toBe(2)
    expect(run('scripts/cleanup.sh').status).toBe(2)
  })

  it('cleanup never kills a pid that is not the doop server it launched', () => {
    const bystander = spawn('sleep', ['60'], { stdio: 'ignore' })
    children.push(bystander)
    const dir = mkdtempSync(join(tmpdir(), 'verify-doop-test-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'pid'), String(bystander.pid))
    const res = run('scripts/cleanup.sh', [dir])
    expect(res.status).not.toBe(0)
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow()
    /* the run directory stays so the operator can look at it */
    expect(existsSync(dir)).toBe(true)
  })
})
