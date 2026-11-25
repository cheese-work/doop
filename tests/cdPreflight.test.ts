import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* CHE-9963 (CHE-9850 S3). Static preflight over the CD files. Each rule has a fixture that fails and a
   fixture that passes; the last block runs every rule over the files in this checkout (actionlint is
   stubbed there: CI may not have the binary, `node scripts/cd-preflight.mjs` runs it for real). */
// @ts-expect-error plain .mjs script, no types
import * as pf from '../scripts/cd-preflight.mjs'

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
const LIFT = `name: CD lift
jobs:
  lift:
    runs-on: [self-hosted, cheese-c00-deploy]
    environment: doop-lift
    steps:
      - run: echo lift
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

const WF = { '.github/workflows/cd-deploy.yml': DEPLOY, '.github/workflows/cd-lift.yml': LIFT }
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

  it.each(['cd-deploy.yml', 'cd-lift.yml'])('fails create-github-app-token in %s', (name) => {
    const path = `.github/workflows/${name}`
    const text = withStep(GOOD[path as keyof typeof GOOD], '          app-id: 1\n')
    const f = pf.checkNoAppToken(withFile(path, text)) as Finding[]
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: 'app-token', file: path })
  })

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
    const text = LIFT.replace('[self-hosted, cheese-c00-deploy]', 'cheese-c00-deploy')
    expect(rules(pf.checkRunnerLabels(withFile('.github/workflows/cd-lift.yml', text)))).toEqual(['runner-labels'])
  })

  it('fails a C00 job with an extra label: it could land on another runner', () => {
    const text = LIFT.replace('[self-hosted, cheese-c00-deploy]', '[self-hosted, Linux, cheese-c00-deploy]')
    expect(rules(pf.checkRunnerLabels(withFile('.github/workflows/cd-lift.yml', text)))).toEqual(['runner-labels'])
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
    const text = LIFT.replace(
      'runs-on: [self-hosted, cheese-c00-deploy]',
      'runs-on:\n      - self-hosted\n      - cheese-c00-deploy',
    )
    expect(rules(pf.checkRunnerLabels(withFile('.github/workflows/cd-lift.yml', text)))).toEqual(['runner-labels'])
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
