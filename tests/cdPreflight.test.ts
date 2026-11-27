import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/* CHE-9963 (CHE-9850 S3). Static preflight over the CD files. Each rule has a fixture that fails and a
   fixture that passes; the last block runs every rule over the files in this checkout (actionlint is
   stubbed there: CI may not have the binary, `node scripts/cd-preflight.mjs` runs it for real). */
// @ts-expect-error plain .mjs script, no types
import * as pf from '../scripts/cd-preflight.mjs'
// @ts-expect-error plain .mjs script, no types
import * as live from '../scripts/cd-preflight-ci.mjs'

type Finding = { rule: string; file: string; line?: number; message: string }
const rules = (f: Finding[]) => [...new Set(f.map((x) => x.rule))].sort()

const README = [
  '| Where         | Name                      | Value |',
  '| ------------- | ------------------------- | ----- |',
  '| Repo variable | `DOOP_DEPLOY_TRAIN`       | `on` or `off` |',
  '| Repo variable | `C00_DOOP_COMPOSE_DIR`    | optional; default `/home/congvc/.local/share/doop` |',
  '| Environment   | `c00-readback-delay`      | 15 minute wait timer |',
  '| Environment   | `doop-lift`               | decision read secrets |',
].join('\n')

const DEPLOY = `name: CD deploy
on:
  schedule:
    - cron: '17 23,7,15 * * *'
jobs:
  resolve:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$T"
        env:
          T: \${{ vars.DOOP_DEPLOY_TRAIN }}
  apply:
    runs-on: [self-hosted, cheese-c00-deploy]
    environment: c00-readback-delay
    env:
      C00_COMPOSE_DIR: \${{ vars.C00_DOOP_COMPOSE_DIR || '/home/congvc/.local/share/doop' }}
    steps:
      - run: echo apply
`
const GATE = `const OWNER = 'congvc-dev'
const MERGERS = new Set([OWNER, 'congvc-bot-x99', 'congvc-bot-x99[bot]'])
`
const WATCH = 'const SLOT_MINUTES = [7 * 60 + 17, 15 * 60 + 17, 23 * 60 + 17]\n'
const PATHS = [
  '# C00 paths',
  '/home/congvc/.local/share/doop',
  '/var/lib/doop-deploy',
  '/var/lock/doop-deploy.lock',
  '',
].join('\n')
const C00SH = 'exec 9>"${C00_LOCK_FILE:-/var/lock/doop-deploy.lock}"\nstate=${C00_STATE_DIR:-/var/lib/doop-deploy}\n'

const WF = { '.github/workflows/cd-deploy.yml': DEPLOY }
const GOOD = {
  ...WF,
  'deploy/cd/README.md': README,
  'deploy/cd/c00-paths.list': PATHS,
  'deploy/cd/c00.sh': C00SH,
  'scripts/deploy-gate.mjs': GATE,
  'scripts/cd-watch.mjs': WATCH,
}
const withFile = (path: string, text: string) => ({ ...GOOD, [path]: text })

describe('baseline', () => {
  it('the good fixture has no finding', () => {
    expect(pf.runPreflight(GOOD)).toEqual([])
  })
})

describe('rule app-token (plan row 3, failure class 5)', () => {
  const step = (inputs: string) =>
    `      - uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0\n        with:\n${inputs}`
  const withStep = (wf: string, inputs: string) => `${wf.trimEnd()}\n${step(inputs)}`

  it.each(['cd-deploy.yml', 'cd-freshness-watch.yml', 'cd-live-revision.yml'])(
    'fails create-github-app-token in %s',
    (name) => {
      const path = `.github/workflows/${name}`
      const text = withStep((GOOD as Record<string, string>)[path] ?? 'name: x\njobs: {}\n', '          app-id: 1\n')
      const f = pf.checkNoAppToken(withFile(path, text)) as Finding[]
      expect(f).toHaveLength(1)
      expect(f[0]).toMatchObject({ rule: 'app-token', file: path })
    },
  )

  it('does not flag the name inside a comment', () => {
    const text = `# the App token step (create-github-app-token) is gone\n${DEPLOY}`
    expect(pf.checkNoAppToken(withFile('.github/workflows/cd-deploy.yml', text))).toEqual([])
  })

  it('class 5: fails the token input `permission-variables` (the real input is permission-actions-variables)', () => {
    const wf = '.github/workflows/cd-freshness-watch.yml'
    const text = withStep('name: x\njobs: {}\n', '          permission-variables: write\n')
    const f = pf.checkTokenInput({ ...GOOD, [wf]: text }) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: 'token-input', file: wf })
  })

  it('class 5: passes `permission-actions-variables`', () => {
    const wf = '.github/workflows/cd-freshness-watch.yml'
    const text = withStep('name: x\njobs: {}\n', '          permission-actions-variables: write\n')
    expect(pf.checkTokenInput({ ...GOOD, [wf]: text })).toEqual([])
  })
})

describe('rule environment', () => {
  it('fails an environment missing from the README', () => {
    const text = DEPLOY.replace('environment: c00-readback-delay', 'environment: ci-app-token')
    const f = pf.checkEnvironments(withFile('.github/workflows/cd-deploy.yml', text)) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: 'environment', file: '.github/workflows/cd-deploy.yml' })
    expect(f[0]?.message).toContain('ci-app-token')
  })

  it('reads the block form `environment:\\n  name: x`', () => {
    const text = DEPLOY.replace(
      'environment: c00-readback-delay',
      'environment:\n      name: ghost\n      url: https://x',
    )
    expect(rules(pf.checkEnvironments(withFile('.github/workflows/cd-deploy.yml', text)))).toEqual(['environment'])
  })

  it('fails an environment given by expression: it cannot be listed', () => {
    const text = DEPLOY.replace('environment: c00-readback-delay', 'environment: ${{ inputs.env }}')
    expect(rules(pf.checkEnvironments(withFile('.github/workflows/cd-deploy.yml', text)))).toEqual(['environment'])
  })

  it('passes when every environment is a README `Environment` row', () => {
    expect(pf.checkEnvironments(GOOD)).toEqual([])
  })
})

describe('rule vars', () => {
  it('fails a vars.X that the README does not list', () => {
    const text = DEPLOY.replace('vars.DOOP_DEPLOY_TRAIN', 'vars.DOOP_NEW_SWITCH')
    const f = pf.checkVars(withFile('.github/workflows/cd-deploy.yml', text)) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]?.message).toContain('DOOP_NEW_SWITCH')
  })

  it('fails a vars.X with a fallback that the README does not mark optional', () => {
    const readme = README.replace('optional; default', 'default')
    const f = pf.checkVars(withFile('deploy/cd/README.md', readme)) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]?.message).toMatch(/C00_DOOP_COMPOSE_DIR.*optional/)
  })

  it('ignores a name inside a comment', () => {
    const text = `# was vars.OLD_SWITCH\n${DEPLOY}`
    expect(pf.checkVars(withFile('.github/workflows/cd-deploy.yml', text))).toEqual([])
  })

  it('passes when every vars.X is a README variable row', () => {
    expect(pf.checkVars(GOOD)).toEqual([])
  })
})

describe('rule mergers (failure class 6)', () => {
  it('class 6: fails when MERGERS lacks the exact merge bot login congvc-bot-x99[bot]', () => {
    const src = "const OWNER = 'congvc-dev'\nconst MERGERS = new Set([OWNER, 'congvc-bot-x99'])\n"
    const f = pf.checkMergers(withFile('scripts/deploy-gate.mjs', src)) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: 'mergers', file: 'scripts/deploy-gate.mjs' })
  })

  it('fails a near miss: another App or a stripped [bot]', () => {
    const src = "const MERGERS = new Set(['congvc-bot-x99-evil[bot]', 'Congvc-Bot-X99[bot]'])\n"
    expect(rules(pf.checkMergers(withFile('scripts/deploy-gate.mjs', src)))).toEqual(['mergers'])
  })

  it('fails when MERGERS cannot be found: no silent pass', () => {
    expect(rules(pf.checkMergers(withFile('scripts/deploy-gate.mjs', 'export {}\n')))).toEqual(['mergers'])
  })

  it('passes with the exact login', () => {
    expect(pf.checkMergers(GOOD)).toEqual([])
  })
})

describe('rule runner-labels', () => {
  it('fails a C00 job with a misspelled label', () => {
    const text = DEPLOY.replace('[self-hosted, cheese-c00-deploy]', '[self-hosted, cheese-c00-deployer]')
    const f = pf.checkRunnerLabels(withFile('.github/workflows/cd-deploy.yml', text)) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: 'runner-labels', file: '.github/workflows/cd-deploy.yml' })
  })

  it('fails a C00 job that drops self-hosted', () => {
    const text = DEPLOY.replace('[self-hosted, cheese-c00-deploy]', 'cheese-c00-deploy')
    expect(rules(pf.checkRunnerLabels(withFile('.github/workflows/cd-deploy.yml', text)))).toEqual(['runner-labels'])
  })

  it('fails a C00 job with an extra label: it could land on another runner', () => {
    const text = DEPLOY.replace('[self-hosted, cheese-c00-deploy]', '[self-hosted, Linux, cheese-c00-deploy]')
    expect(rules(pf.checkRunnerLabels(withFile('.github/workflows/cd-deploy.yml', text)))).toEqual(['runner-labels'])
  })

  it('fails a self-hosted job with an unknown label in any CD workflow', () => {
    const wf = '.github/workflows/cd-live-revision.yml'
    const text = 'jobs:\n  live:\n    runs-on: [self-hosted, Linux, X64, cheese-x98-gate]\n'
    expect(rules(pf.checkRunnerLabels({ ...GOOD, [wf]: text }))).toEqual(['runner-labels'])
  })

  it('passes hosted runners and the X99 gate runner of the live watcher', () => {
    const wf = '.github/workflows/cd-live-revision.yml'
    const text =
      'jobs:\n  live:\n    runs-on: [self-hosted, Linux, X64, cheese-x99-gate]\n  other:\n    runs-on: ubuntu-24.04\n'
    expect(pf.checkRunnerLabels({ ...GOOD, [wf]: text })).toEqual([])
  })

  it('fails a runs-on it cannot read (block form): no silent pass', () => {
    const text = DEPLOY.replace(
      'runs-on: [self-hosted, cheese-c00-deploy]',
      'runs-on:\n      - self-hosted\n      - cheese-c00-deploy',
    )
    expect(rules(pf.checkRunnerLabels(withFile('.github/workflows/cd-deploy.yml', text)))).toEqual(['runner-labels'])
  })

  it('passes the good fixture', () => {
    expect(pf.checkRunnerLabels(GOOD)).toEqual([])
  })
})

describe('rule c00-paths', () => {
  it('fails a path the scripts use that the list does not hold', () => {
    const f = pf.checkC00Paths(
      withFile('deploy/cd/c00.sh', `${C00SH}cp x /var/lib/doop-deploy2/y\ncp x /var/lib/docker/y\n`),
    ) as Finding[]
    expect(f.map((x) => x.message).join('\n')).toContain('/var/lib/doop-deploy2/y')
    expect(rules(f)).toEqual(['c00-paths'])
  })

  it('accepts a path below a listed directory', () => {
    expect(pf.checkC00Paths(withFile('deploy/cd/c00.sh', `${C00SH}cat /var/lib/doop-deploy/deploy-marker\n`))).toEqual(
      [],
    )
  })

  it('fails a list entry outside the allowed prefixes', () => {
    const list = `${PATHS}/etc/shadow\n/home/congvc/.ssh\n`
    const f = pf.checkC00Paths(withFile('deploy/cd/c00-paths.list', list)) as Finding[]
    expect(f).toHaveLength(2)
    expect(f.every((x) => x.rule === 'c00-paths' && x.file === 'deploy/cd/c00-paths.list')).toBe(true)
  })

  it('fails a list entry with a parent-directory segment', () => {
    const list = `${PATHS}/var/lib/doop-deploy/../../etc\n`
    expect(rules(pf.checkC00Paths(withFile('deploy/cd/c00-paths.list', list)))).toEqual(['c00-paths'])
  })

  it('fails when the list file is missing', () => {
    const { ['deploy/cd/c00-paths.list']: _gone, ...rest } = GOOD
    expect(rules(pf.checkC00Paths(rest))).toEqual(['c00-paths'])
  })

  it('finds a path in a workflow, even as a fallback inside an expression', () => {
    const text = DEPLOY.replace("'/home/congvc/.local/share/doop'", "'/home/congvc/elsewhere'")
    const f = pf.checkC00Paths(withFile('.github/workflows/cd-deploy.yml', text)) as Finding[]
    expect(f.map((x) => x.message).join('\n')).toContain('/home/congvc/elsewhere')
  })

  it('ignores a path inside a comment line', () => {
    expect(pf.checkC00Paths(withFile('deploy/cd/c00.sh', `# see /var/log/x\n${C00SH}`))).toEqual([])
  })

  it('passes the good fixture', () => {
    expect(pf.checkC00Paths(GOOD)).toEqual([])
  })
})

describe('rule cron-slots (new in plan r5)', () => {
  it('fails when the cron moves to 12 h and SLOT_MINUTES stays at 8 h', () => {
    const text = DEPLOY.replace("'17 23,7,15 * * *'", "'17 7,19 * * *'")
    const f = pf.checkCronSlots(withFile('.github/workflows/cd-deploy.yml', text)) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: 'cron-slots', file: '.github/workflows/cd-deploy.yml' })
  })

  it('fails when SLOT_MINUTES moves to 12 h and the cron stays at 8 h', () => {
    const src = 'const SLOT_MINUTES = [7 * 60 + 17, 19 * 60 + 17]\n'
    expect(rules(pf.checkCronSlots(withFile('scripts/cd-watch.mjs', src)))).toEqual(['cron-slots'])
  })

  it('fails when only the minute drifts', () => {
    const text = DEPLOY.replace("'17 23,7,15 * * *'", "'18 23,7,15 * * *'")
    expect(rules(pf.checkCronSlots(withFile('.github/workflows/cd-deploy.yml', text)))).toEqual(['cron-slots'])
  })

  it('passes a 12 h change made in both places, in any hour order', () => {
    const text = DEPLOY.replace("'17 23,7,15 * * *'", "'17 19,7 * * *'")
    const src = 'const SLOT_MINUTES = [7 * 60 + 17, 19 * 60 + 17]\n'
    const files = { ...GOOD, '.github/workflows/cd-deploy.yml': text, 'scripts/cd-watch.mjs': src }
    expect(pf.checkCronSlots(files)).toEqual([])
  })

  it('fails two cron entries, a non-daily cron or a cron it cannot read', () => {
    const two = DEPLOY.replace(
      "    - cron: '17 23,7,15 * * *'\n",
      "    - cron: '17 23,7,15 * * *'\n    - cron: '47 * * * *'\n",
    )
    const weekly = DEPLOY.replace("'17 23,7,15 * * *'", "'17 23,7,15 * * 1'")
    const range = DEPLOY.replace("'17 23,7,15 * * *'", "'17 */8 * * *'")
    for (const text of [two, weekly, range]) {
      expect(rules(pf.checkCronSlots(withFile('.github/workflows/cd-deploy.yml', text)))).toEqual(['cron-slots'])
    }
  })

  it('fails when SLOT_MINUTES cannot be read', () => {
    expect(rules(pf.checkCronSlots(withFile('scripts/cd-watch.mjs', 'export {}\n')))).toEqual(['cron-slots'])
  })

  it('passes the good fixture', () => {
    expect(pf.checkCronSlots(GOOD)).toEqual([])
  })
})

describe('rule actionlint', () => {
  const paths = ['.github/workflows/cd-deploy.yml']
  it('passes when actionlint exits 0', () => {
    expect(pf.runActionlint(paths, () => ({ status: 0, stdout: '', stderr: '' }))).toEqual([])
  })

  it('turns each reported line into a finding with file and line', () => {
    const out = '.github/workflows/cd-deploy.yml:12:7: property "x" is not defined [expression]\n'
    const f = pf.runActionlint(paths, () => ({ status: 1, stdout: out, stderr: '' })) as Finding[]
    expect(f).toEqual([
      {
        rule: 'actionlint',
        file: '.github/workflows/cd-deploy.yml',
        line: 12,
        message: 'property "x" is not defined [expression]',
      },
    ])
  })

  it('fails when the binary is missing: no silent pass', () => {
    const f = pf.runActionlint(paths, () => ({ error: { code: 'ENOENT' } })) as Finding[]
    expect(rules(f)).toEqual(['actionlint'])
    expect(f[0]?.message).toMatch(/not found|install/i)
  })

  it('fails a non-zero exit with no readable line (crash, bad config)', () => {
    const f = pf.runActionlint(paths, () => ({ status: 3, stdout: '', stderr: 'config error' })) as Finding[]
    expect(rules(f)).toEqual(['actionlint'])
    expect(f[0]?.message).toContain('config error')
  })

  it('runs with the repo config file so the C00 runner label is known', () => {
    let args: string[] = []
    pf.runActionlint(paths, (_cmd: string, a: string[]) => {
      args = a
      return { status: 0, stdout: '', stderr: '' }
    })
    expect(args).toContain('-config-file')
    expect(args).toContain('.github/actionlint.yaml')
    expect(args).toContain(paths[0])
  })
})

describe('runPreflight', () => {
  it('collects the findings of every rule', () => {
    const files = {
      ...GOOD,
      'scripts/deploy-gate.mjs': "const MERGERS = new Set(['congvc-dev'])\n",
      'scripts/cd-watch.mjs': 'const SLOT_MINUTES = [7 * 60 + 17]\n',
    }
    expect(rules(pf.runPreflight(files))).toEqual(['cron-slots', 'mergers'])
  })

  it('formats a finding as `file:line: [rule] message`', () => {
    expect(pf.formatFinding({ rule: 'mergers', file: 'a.mjs', line: 3, message: 'm' })).toBe('a.mjs:3: [mergers] m')
    expect(pf.formatFinding({ rule: 'mergers', file: 'a.mjs', message: 'm' })).toBe('a.mjs: [mergers] m')
  })
})

describe('the CD files in this checkout', () => {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  const files: Record<string, string> = {}
  for (const f of readdirSync('.github/workflows').filter((n) => /^cd-.*\.yml$/.test(n))) {
    files[`.github/workflows/${f}`] = read(`.github/workflows/${f}`)
  }
  for (const p of [...pf.SCRIPT_FILES, 'deploy/cd/README.md', 'deploy/cd/c00-paths.list']) files[p] = read(p)

  it('pass every static rule', () => {
    expect(pf.runPreflight(files).map(pf.formatFinding)).toEqual([])
  })

  it('include the files the rules read', () => {
    expect(files['scripts/cd-watch.mjs']).toContain('SLOT_MINUTES')
    expect(files['.github/workflows/cd-deploy.yml']).toContain('cron:')
  })
})

/* CHE-9957 (CHE-9850 S6). The live preflight workflow `cd-preflight.yml`: scope, github, c00, report. The report
   job must never wait on the C00 runner (FP-01): it has its own clock, and a job that stays queued is a dead runner. */
const MIN = 60_000
const WORKFLOW = readFileSync('.github/workflows/cd-preflight.yml', 'utf8')

/** The text of one top-level job (`  name:` under `jobs:`), up to the next job. */
const jobBlock = (text: string, name: string) => {
  const start = text.search(new RegExp(`^  ${name}:\\s*$`, 'm'))
  if (start < 0) return ''
  const rest = text.slice(start).split('\n').slice(1)
  const end = rest.findIndex((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l))
  return [text.slice(start).split('\n')[0], ...(end < 0 ? rest : rest.slice(0, end))].join('\n')
}
const field = (block: string, key: string) => new RegExp(`^    ${key}:[ \\t]*(.*)$`, 'm').exec(block)?.[1]?.trim()
/** `needs:` as a flow list or a block list. */
const needsOf = (block: string): string[] => {
  const inline = field(block, 'needs')
  if (inline)
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  const m = /^ {4}needs:\s*\n((?: {6}- .*\n?)+)/m.exec(block)
  return m
    ? m[1]!
        .split('\n')
        .map((l) => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean)
    : []
}

type Job = { status: string; conclusion?: string | null }
const fakeClock = () => {
  let t = 1_000_000
  return { now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t - 1_000_000 }
}

describe('FP-01 report never waits on a dead C00 runner', () => {
  it('FP-01 unit: c00 stays queued, report fails "C00 runner offline" at 10 min and never reads the conclusion', async () => {
    const clock = fakeClock()
    let conclusionReads = 0
    let calls = 0
    const queued = {
      status: 'queued',
      get conclusion() {
        conclusionReads++
        return 'success'
      },
    }
    const out = await live.waitForC00({ observe: async () => (calls++, queued), ...clock })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('C00 runner offline')
    expect(clock.elapsed()).toBe(10 * MIN)
    expect(conclusionReads).toBe(0)
    expect(calls).toBeGreaterThan(10)
  })

  it('FP-01 unit: no c00 job at all is the same as a queued one', async () => {
    const clock = fakeClock()
    const out = await live.waitForC00({ observe: async () => null, ...clock })
    expect(out.message).toContain('C00 runner offline')
    expect(clock.elapsed()).toBe(10 * MIN)
  })

  it('FP-01 yaml: report needs scope and github only, times out within 12 min, and always runs', () => {
    const report = jobBlock(WORKFLOW, 'report')
    expect(report).not.toBe('')
    expect(needsOf(report).sort()).toEqual(['github', 'scope'])
    expect(needsOf(report)).not.toContain('c00')
    expect(Number(field(report, 'timeout-minutes'))).toBeLessThanOrEqual(12)
    expect(field(report, 'if')).toBe('always()')
  })
})

describe('waitForC00 (after the runner picked the job up)', () => {
  const run = (seq: Job[], extra: Record<string, number> = {}) => {
    const clock = fakeClock()
    let i = 0
    return live
      .waitForC00({ observe: async () => seq[Math.min(i++, seq.length - 1)], ...clock, ...extra })
      .then((out: { ok: boolean; message: string }) => ({ out, elapsed: clock.elapsed() }))
  }

  it('passes when c00 starts late but inside 10 min and succeeds', async () => {
    const { out } = await run([
      { status: 'queued' },
      { status: 'queued' },
      { status: 'in_progress' },
      { status: 'completed', conclusion: 'success' },
    ])
    expect(out.ok).toBe(true)
  })

  it('fails with the conclusion when c00 completes red', async () => {
    const { out } = await run([{ status: 'completed', conclusion: 'failure' }])
    expect(out.ok).toBe(false)
    expect(out.message).toContain('failure')
  })

  it('treats a skipped c00 as nothing to wait for', async () => {
    const { out } = await run([{ status: 'completed', conclusion: 'skipped' }])
    expect(out.ok).toBe(true)
  })

  it('fails when c00 started but did not finish by the deadline, before the report timeout', async () => {
    const { out, elapsed } = await run([{ status: 'in_progress' }])
    expect(out.ok).toBe(false)
    expect(out.message).toContain('did not finish')
    expect(elapsed).toBeLessThan(12 * MIN)
  })

  it('a job that starts at 9 min 59 s is not offline', async () => {
    const seq: Job[] = Array.from({ length: 39 }, () => ({ status: 'queued' }))
    seq.push({ status: 'completed', conclusion: 'success' })
    const { out } = await run(seq)
    expect(out.ok).toBe(true)
  })

  it('retries an unreadable job list instead of failing at once', async () => {
    const clock = fakeClock()
    let n = 0
    const out = await live.waitForC00({
      observe: async () => {
        if (n++ < 2) throw new Error('HTTP 502')
        return { status: 'completed', conclusion: 'success' }
      },
      ...clock,
    })
    expect(out.ok).toBe(true)
  })
})

describe('decideReport', () => {
  const ok = { scope: 'success', github: 'success', cd: 'true', c00: { ok: true, message: 'c00 ok' } }
  it('passes when every part passed', () => expect(live.decideReport(ok).ok).toBe(true))
  it('reports n/a for a PR that touches no CD path', () => {
    const r = live.decideReport({ scope: 'success', github: 'skipped', cd: 'false', c00: null })
    expect(r.ok).toBe(true)
    expect(r.lines.join('\n')).toContain('n/a')
  })
  it('fails when scope failed, whatever else says', () => {
    expect(live.decideReport({ ...ok, scope: 'failure' }).ok).toBe(false)
  })
  it('fails when github failed or was cancelled', () => {
    expect(live.decideReport({ ...ok, github: 'failure' }).ok).toBe(false)
    expect(live.decideReport({ ...ok, github: 'cancelled' }).ok).toBe(false)
  })
  it('fails and says why when c00 is offline', () => {
    const r = live.decideReport({ ...ok, c00: { ok: false, message: 'C00 runner offline' } })
    expect(r.ok).toBe(false)
    expect(r.lines.join('\n')).toContain('C00 runner offline')
  })
  it('a CD PR with no c00 answer (a fork head) passes on scope and github', () => {
    expect(live.decideReport({ ...ok, c00: null }).ok).toBe(true)
  })
})

describe('scope', () => {
  it.each([
    '.github/workflows/cd-deploy.yml',
    '.github/workflows/cd-preflight.yml',
    '.github/workflows/image.yml',
    '.github/actionlint.yaml',
    'deploy/cd/c00.sh',
    'deploy/cd/README.md',
    'scripts/cd-watch.mjs',
    'scripts/deploy-gate.mjs',
    'scripts/gh-rate-limit.mjs',
    'scripts/image-evidence.mjs',
  ])('%s is a CD path', (p) => expect(live.isCdPath(p)).toBe(true))

  it.each([
    'src/App.tsx',
    'server/store.ts',
    'tests/cdPreflight.test.ts',
    '.github/workflows/ci.yml',
    'scripts/doc-lint.mjs',
  ])('%s is not', (p) => expect(live.isCdPath(p)).toBe(false))

  it('a PR is CD when any one file is', () => {
    expect(live.touchesCd(['src/a.ts', 'deploy/cd/c00.sh'])).toBe(true)
    expect(live.touchesCd(['src/a.ts', 'README.md'])).toBe(false)
    expect(live.touchesCd([])).toBe(false)
  })

  it('only a same-repo head runs on the C00 runner', () => {
    expect(live.sameRepo('cheese-work/doop', 'cheese-work/doop')).toBe(true)
    expect(live.sameRepo('someone/doop', 'cheese-work/doop')).toBe(false)
    expect(live.sameRepo('', 'cheese-work/doop')).toBe(false)
    expect(live.sameRepo('Cheese-Work/doop-evil', 'cheese-work/doop')).toBe(false)
  })
})

describe('quota', () => {
  it('warns below 20 percent', () => {
    expect(live.quotaStatus({ limit: 1000, remaining: 199 }).warn).toBe(true)
    expect(live.quotaStatus({ limit: 1000, remaining: 200 }).warn).toBe(false)
    expect(live.quotaStatus({ limit: 1000, remaining: 0 }).warn).toBe(true)
  })
  it('names the figures', () => {
    expect(live.quotaStatus({ limit: 1000, remaining: 150 }).message).toContain('150 of 1000')
  })
  it('an unreadable quota is a warning, never a pass of the figure', () => {
    const q = live.quotaStatus(null)
    expect(q.warn).toBe(true)
    expect(q.message).toContain('unreadable')
  })
})

describe('live names (environments and variables exist)', () => {
  const README_REQUIRED = README.replace('`on` or `off`', 'required; `on` or `off`')
  const files = { '.github/workflows/cd-deploy.yml': DEPLOY }
  it('passes when every referenced environment and variable exists', () => {
    expect(
      live.checkLiveNames(files, {
        environments: ['c00-readback-delay'],
        variables: ['DOOP_DEPLOY_TRAIN', 'C00_DOOP_COMPOSE_DIR'],
      }),
    ).toEqual([])
  })
  it('finds a missing environment (failure class 2)', () => {
    const f = live.checkLiveNames(files, { environments: [], variables: ['DOOP_DEPLOY_TRAIN', 'C00_DOOP_COMPOSE_DIR'] })
    expect(f.map((x: Finding) => x.rule)).toEqual(['live-environment'])
    expect(f[0].message).toContain('c00-readback-delay')
  })
  it('finds a missing required variable but not an optional or unmarked one', () => {
    const f = live.checkLiveNames(files, { environments: ['c00-readback-delay'], variables: [] }, README_REQUIRED)
    expect(f.map((x: Finding) => x.message).join('\n')).toContain('DOOP_DEPLOY_TRAIN')
    expect(f.map((x: Finding) => x.message).join('\n')).not.toContain('C00_DOOP_COMPOSE_DIR')
  })
  it('an unreadable list is a warning for the caller, not a finding here', () => {
    expect(live.checkLiveNames(files, { environments: null, variables: null }, README)).toEqual([])
  })
})

describe('the preflight workflow file', () => {
  const triggers = pf.stripComments(WORKFLOW.split(/^jobs:/m)[0]!)
  const jobs = ['scope', 'github', 'c00', 'report'].map((n) => [n, jobBlock(WORKFLOW, n)] as const)

  it('has the four jobs', () => {
    for (const [name, block] of jobs) expect(block, name).not.toBe('')
  })
  it('fires on pull_request_target, a 15 minute schedule and dispatch, and not on merge_group (no queue rule)', () => {
    expect(triggers).toMatch(/pull_request_target:\s*\n\s*types: \[opened, synchronize, reopened, ready_for_review\]/)
    expect(triggers).toMatch(/cron: '\*\/15 \* \* \* \*'|cron: '(\d+,){3}\d+ \* \* \* \*'/)
    expect(triggers).toContain('workflow_dispatch:')
    expect(triggers).not.toContain('merge_group')
  })
  it('holds no secret, no persisted credential and no head checkout', () => {
    expect(WORKFLOW).not.toMatch(/\bsecrets\./)
    expect(WORKFLOW).not.toContain('create-github-app-token')
    const checkouts = [...WORKFLOW.matchAll(/uses: actions\/checkout@[^\n]*\n((?:\s+(?:with|[a-z-]+):[^\n]*\n)*)/g)]
    expect(checkouts.length).toBeGreaterThan(0)
    for (const m of checkouts) {
      expect(m[1]).toContain('persist-credentials: false')
      expect(m[1]).not.toMatch(/ref:.*(\.head\.|head_ref|refs\/pull)/)
      expect(m[1]).toContain('pull_request.base.sha')
    }
  })
  it('never puts event data inside a run script', () => {
    const runs = [...WORKFLOW.matchAll(/^\s+run: ?([^\n]*(?:\n(?:\s{10,}[^\n]*|)(?=\n|$))*)/gm)].map((m) => m[0])
    for (const r of runs) expect(r).not.toContain('${{')
  })
  it('c00 is read only: exact runner labels, 5 min, no deploy group, same-repo heads', () => {
    const c00 = jobBlock(WORKFLOW, 'c00')
    expect(field(c00, 'runs-on')).toBe('[self-hosted, cheese-c00-deploy]')
    expect(Number(field(c00, 'timeout-minutes'))).toBeLessThanOrEqual(5)
    expect(c00).not.toContain('concurrency')
    expect(WORKFLOW).not.toContain('c00-deploy-doop')
    expect(c00).toContain("c00_expected == 'true'")
    expect(c00).toContain('c00.sh preflight')
  })
  it('only report may be required: the others do not name it', () => {
    for (const n of ['scope', 'github', 'c00']) expect(needsOf(jobBlock(WORKFLOW, n))).not.toContain('report')
  })
  it('the workflow-level permissions are read only', () => {
    const perms = /^permissions:\n((?:  .*\n)+)/m.exec(WORKFLOW)?.[1] ?? ''
    expect(perms).not.toMatch(/: write/)
  })
})

describe('c00.sh preflight (read only)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cd-preflight-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const MARKER = `clear:${'a'.repeat(32)}:restore`
  const prep = (
    name: string,
    opts: { marker?: string | null; lock?: boolean; docker?: boolean; list?: string } = {},
  ) => {
    const dir = join(root, name)
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\n${opts.docker === false ? 'echo cannot connect >&2; exit 1' : 'echo 27.0'}\n`,
    )
    chmodSync(join(bin, 'docker'), 0o755)
    if (opts.marker !== null) writeFileSync(join(dir, 'deploy-marker'), `${opts.marker ?? MARKER}\n`)
    if (opts.lock !== false) writeFileSync(join(dir, 'lock'), '')
    writeFileSync(join(dir, 'paths.list'), opts.list ?? '# list\n/var/lib/doop-deploy\n/var/lock/doop-deploy.lock\n')
    return {
      dir,
      run: () =>
        spawnSync('bash', ['deploy/cd/c00.sh', 'preflight', join(dir, 'paths.list')], {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            C00_STATE_DIR: dir,
            C00_LOCK_FILE: join(dir, 'lock'),
          },
        }),
    }
  }

  it('passes when every fact holds, and writes nothing', () => {
    const t = prep('ok')
    const r = t.run()
    expect(r.status, r.stderr + r.stdout).toBe(0)
    expect(readdirSync(t.dir).sort()).toEqual(['bin', 'deploy-marker', 'lock', 'paths.list'])
    expect(readFileSync(join(t.dir, 'deploy-marker'), 'utf8')).toBe(`${MARKER}\n`)
  })
  it('accepts armed and suspended markers as readable states', () => {
    for (const m of [
      `armed:${'b'.repeat(32)}:12:${'c'.repeat(40)}`,
      `suspended:${'b'.repeat(32)}:12:${'c'.repeat(40)}:drill`,
    ]) {
      const r = prep(`state-${m.split(':')[0]}`, { marker: m }).run()
      expect(r.status, r.stderr).toBe(0)
    }
  })
  it('fails on a missing marker', () => {
    const r = prep('nomarker', { marker: null }).run()
    expect(r.status).toBe(1)
    expect(r.stderr + r.stdout).toMatch(/marker/)
  })
  it('fails on a marker with no valid state word', () => {
    const r = prep('badmarker', { marker: 'maybe:soon' }).run()
    expect(r.status).toBe(1)
    expect(r.stderr + r.stdout).toMatch(/marker/)
  })
  it('fails when docker does not answer', () => {
    const r = prep('nodocker', { docker: false }).run()
    expect(r.status).toBe(1)
    expect(r.stderr + r.stdout).toMatch(/docker/)
  })
  it('fails when the lock file is missing, and does not create it', () => {
    const t = prep('nolock', { lock: false })
    const r = t.run()
    expect(r.status).toBe(1)
    expect(r.stderr + r.stdout).toMatch(/lock/)
    expect(existsSync(join(t.dir, 'lock'))).toBe(false)
  })
  it('fails on a head path outside the allowed prefixes', () => {
    const r = prep('badpath', { list: '/var/lib/doop-deploy\n/etc/passwd\n' }).run()
    expect(r.status).toBe(1)
    expect(r.stderr + r.stdout).toContain('/etc/passwd')
  })
  it('fails on a path with .. in it', () => {
    const r = prep('dotdot', { list: '/var/lib/doop-deploy/../../etc\n' }).run()
    expect(r.status).toBe(1)
  })
})
