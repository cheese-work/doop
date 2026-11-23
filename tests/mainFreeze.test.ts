import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* CHE-7594 (plan CHE-7309 r13, step P3a): scripts/doop-main-freeze.sh `plan` and `status`, with the three
   libraries it shares with later parts: gh-read.sh (bounded reads), ruleset-owner.sh (ownership) and
   freeze-classify.sh (refusal table). A fake `gh` serves fixture files with a controlled `Date` header and
   logs every write; a fake `multica` serves the intent comments. */

const SCRIPT = resolve('scripts/doop-main-freeze.sh')
const LIB = (n: string) => resolve('scripts/lib', n)

const MF = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const PROBE_NAMES = ['q-frozen', 'q-open', 'd-frozen', 'd-open']
const PROBE_SHAS = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40), '4'.repeat(40)]
const PROBE_LIST = PROBE_NAMES.map((n, i) => `${n}=${PROBE_SHAS[i]}`).join(',')
const NONCE = 'a1b2c3d4'
const ADMIN = 'admin-member-id'
const ISSUE = 'p9-issue'
const T0 = 1_795_000_000 // fake GitHub server time (epoch s)
const CTX = 'main-frozen (CHE-7309)'
const FREEZE_INCLUDE = ['refs/heads/main', 'refs/heads/freeze-probe/q-frozen', 'refs/heads/freeze-probe/d-frozen']
const MIRROR_INCLUDE = PROBE_NAMES.map((n) => `refs/heads/freeze-probe/${n}`)

// fixture JSON is untyped on purpose
// eslint-disable-next-line typescript/no-explicit-any
type J = Record<string, any>

// [lo, hi] in epoch ms from the first `lo=<iso> hi=<iso>` pair of a line
const boundsOf = (line: string): [number, number] => {
  const m = /lo=(\S+) hi=(\S+)/.exec(line)
  if (!m) throw new Error(`no bounds in: ${line}`)
  return [Date.parse(m[1] ?? ''), Date.parse(m[2] ?? '')]
}

const extras = { node_id: 'RRS_x', created_at: '2026-11-19T00:00:00Z', updated_at: '2026-11-19T00:00:01Z', _links: {} }
const sourceDetail = (id: number, name: string, rules: J[], bypass: J[] | null = []): J => ({
  id,
  name,
  target: 'branch',
  source_type: 'Repository',
  enforcement: 'active',
  bypass_actors: bypass,
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  rules,
  current_user_can_bypass: 'pull_requests_only',
  ...extras,
})
const S1 = sourceDetail(26093168, 'protect default branches', [
  { type: 'non_fast_forward' },
  { type: 'merge_queue', parameters: { check_response_timeout_minutes: 60, grouping_strategy: 'ALLGREEN' } },
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: 'build', integration_id: 15368 }],
    },
  },
])
const S2 = sourceDetail(27606879, 'protect main (repo copy)', [
  { type: 'deletion' },
  { type: 'non_fast_forward' },
  { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
])

// a third source that no fixed id list knows: bypass actors and updated_at are part of Pm
const S3 = sourceDetail(
  28000001,
  'protect main (new source)',
  [{ type: 'deletion' }],
  [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
)

const freezeRules = (): J[] => [
  { type: 'update' },
  { type: 'deletion' },
  { type: 'non_fast_forward' },
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: CTX }],
    },
  },
]
const freezeDetail = (id: number, nonce = NONCE, over: J = {}): J => ({
  id,
  name: `freeze main (CHE-7309) #${nonce}`,
  target: 'branch',
  source_type: 'Repository',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: [...FREEZE_INCLUDE], exclude: [] } },
  rules: freezeRules(),
  current_user_can_bypass: 'never',
  ...extras,
  ...over,
})
const mirrorDetail = (id: number, nonce: string, src: J, over: J = {}): J => ({
  id,
  name: `freeze probe mirror (CHE-7309) #${nonce}.${src.id}`,
  target: 'branch',
  source_type: 'Repository',
  enforcement: src.enforcement,
  bypass_actors: src.bypass_actors,
  conditions: { ref_name: { include: [...MIRROR_INCLUDE], exclude: [] } },
  rules: src.rules,
  current_user_can_bypass: 'never',
  ...extras,
  ...over,
})
const BASE_REF = 'refs/heads/cheese/main'
const fenceDetail = (id: number, nonce = NONCE, over: J = {}): J => ({
  id,
  name: `port merge fence (CHE-7309) #${nonce}`,
  target: 'branch',
  source_type: 'Repository',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: [BASE_REF], exclude: [] } },
  rules: [
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: ['commit-message', 'typecheck', 'lint', 'build', 'tests'].map((context) => ({
          context,
        })),
      },
    },
    {
      type: 'pull_request',
      parameters: {
        allowed_merge_methods: ['merge'],
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
      },
    },
  ],
  current_user_can_bypass: 'never',
  ...extras,
  ...over,
})
const actorDetail = (id: number, nonce = NONCE, over: J = {}): J => ({
  id,
  name: `port merge actor (CHE-7309) #${nonce}`,
  target: 'branch',
  source_type: 'Repository',
  enforcement: 'active',
  bypass_actors: [{ actor_id: 129714106, actor_type: 'User', bypass_mode: 'pull_request' }],
  conditions: { ref_name: { include: [BASE_REF], exclude: [] } },
  rules: [{ type: 'update' }],
  current_user_can_bypass: 'never',
  ...extras,
  ...over,
})
const pinOwn = (id: number, nonce = NONCE, over: J = {}): J => ({
  id,
  name: `port head pin (CHE-7309) #${nonce}`,
  target: 'branch',
  source_type: 'Repository',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['refs/heads/agent/x'], exclude: [] } },
  rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
  current_user_can_bypass: 'never',
  ...extras,
  ...over,
})
const summary = (d: J) => ({
  id: d.id,
  name: d.name,
  target: d.target,
  enforcement: d.enforcement,
  source_type: d.source_type,
})
const ruleRows = (d: J) =>
  d.rules.map((r: J) => ({
    ...r,
    ruleset_source_type: 'Repository',
    ruleset_source: 'cheese-work/doop',
    ruleset_id: d.id,
  }))
const intent = (nonce: string, kind = 'freeze', author = ADMIN): J => ({
  id: `c-${nonce}`,
  author_id: author,
  author_type: 'member',
  content: `freeze-evidence v1 nonce=${nonce} seq=1 prev=0 kind=intent lo=x hi=y body_sha256=z\n\n\`\`\`json\n{}\n\`\`\`\n${kind}-intent v1 nonce=${nonce} op=apply main=${MF}\n`,
})

const FAKE_GH = `#!/usr/bin/env bash
# fake gh: serves $FAKE_DIR/<fixture>, logs calls, records writes in $FAKE_DIR/writes
echo "$*" >> "$FAKE_DIR/log"
args=("$@"); path=""; method=GET; write=0; i=0
while [ $i -lt $# ]; do
  a="\${args[$i]}"
  case "$a" in
    api|-i|--include) ;;
    -X|--method) i=$((i+1)); method="\${args[$i]}"; [ "$method" != GET ] && write=1 ;;
    --input) write=1; i=$((i+1)) ;;
    -f|-F|--field|--raw-field) i=$((i+1)); [ "$path" != graphql ] && write=1 ;;
    -H|--header|--jq|-q) i=$((i+1)) ;;
    -*) ;;
    *) [ -z "$path" ] && path="$a" ;;
  esac
  i=$((i+1))
done
if [ $write = 1 ]; then echo "$*" >> "$FAKE_DIR/writes"; fi
n=$(( $(cat "$FAKE_DIR/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE_DIR/n"
t=$(( \${FAKE_T0} + n * \${FAKE_STEP:-3} ))
echo $t >> "$FAKE_DIR/dates"
stamp=$(/usr/bin/date -u -d @$t '+%a, %d %b %Y %H:%M:%S GMT')
p="\${path#repos/cheese-work/doop/}"
page=1; case "$p" in *page=*) page="\${p##*page=}"; page="\${page%%&*}" ;; esac
f=""
case "$p" in
  rate_limit) f=rate_limit.json ;;
  graphql) f=queue.json ;;
  git/matching-refs/*) f=groups.json ;;
  pulls\\?*) f=pulls.json ;;
  git/ref/heads/*) q="\${p#git/ref/heads/}"; q="\${q%%\\?*}"; f="ref-\${q//\\//-}.json" ;;
  compare/*) f=compare.json ;;
  rulesets/*) q="\${p#rulesets/}"; q="\${q%%\\?*}"; f="ruleset-$q.json" ;;
  rulesets|rulesets\\?*) f=rulesets.json ;;
  rules/branches/*) q="\${p#rules/branches/}"; q="\${q%%\\?*}"; f="rules-\${q//\\//-}.json" ;;
  contents/.github/workflows/*) q="\${p#contents/.github/workflows/}"; q="\${q%%\\?*}"; f="wf-$q" ;;
  contents/.github/workflows*) f=wf-list.json ;;
esac
status="200 OK"; body=""
if [ $write = 1 ]; then status="201 Created"; body='{"id":999}'
elif [ -z "$f" ] || [ ! -f "$FAKE_DIR/$f" ]; then status="404 Not Found"; body='{"message":"Not Found"}'
else
  body=$(cat "$FAKE_DIR/$f")
  case "$p" in git/matching-refs/*|pulls\\?*) [ "$page" -gt 1 ] && body='[]' ;; esac
fi
printf 'HTTP/2.0 %s\\r\\n' "$status"
case "$*" in *"$FAKE_NODATE"*) [ -n "$FAKE_NODATE" ] || printf 'Date: %s\\r\\n' "$stamp" ;; *) printf 'Date: %s\\r\\n' "$stamp" ;; esac
printf 'Content-Type: application/json\\r\\n\\r\\n%s\\n' "$body"
case "$status" in 2*) exit 0 ;; *) exit 1 ;; esac
`

const FAKE_MULTICA = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/mlog"
case "$*" in
  "issue comment list "*"--full"*"--output json"*) cat "$FAKE_DIR/comments.json"; exit 0 ;;
esac
echo "$*" >> "$FAKE_DIR/writes"
exit 1
`

// 10 minutes of skew on every clock read of the local machine; parsing and formatting with -d pass through
const SKEW_DATE = `#!/usr/bin/env bash
for a in "$@"; do [ "$a" = -d ] && exec /usr/bin/date "$@"; done
exec /usr/bin/date -d '+10 minutes' "$@"
`

let dir: string
let fx: string
const put = (name: string, v: unknown) => writeFileSync(join(fx, name), typeof v === 'string' ? v : JSON.stringify(v))

type World = { rulesets: J[]; comments: J[]; rules?: J[] }
const freshWorld = (): World => ({ rulesets: [S1, S2], comments: [] })
const writeWorld = (w: World) => {
  put('rate_limit.json', { resources: {} })
  put('queue.json', { data: { repository: { mergeQueue: { entries: { totalCount: 0, nodes: [] } } } } })
  put('groups.json', [])
  put('pulls.json', [])
  put('ref-main.json', { ref: 'refs/heads/main', object: { sha: MF } })
  PROBE_NAMES.forEach((n, i) => put(`ref-freeze-probe-${n}.json`, { object: { sha: PROBE_SHAS[i] } }))
  put('compare.json', { status: 'behind', behind_by: 0 })
  put('rulesets.json', w.rulesets.map(summary))
  for (const d of w.rulesets) put(`ruleset-${d.id}.json`, d)
  put(
    'rules-main.json',
    w.rules ?? w.rulesets.filter((d) => d.conditions.ref_name.include.includes('refs/heads/main')).flatMap(ruleRows),
  )
  for (const n of PROBE_NAMES) {
    put(
      `rules-freeze-probe-${n}.json`,
      w.rulesets
        .filter((d) => d.conditions.ref_name.include.includes(`refs/heads/freeze-probe/${n}`))
        .flatMap(ruleRows),
    )
  }
  put('wf-list.json', [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }])
  put('wf-ci.yml', 'name: ci\njobs:\n  build:\n    runs-on: ubuntu-latest\n')
  put('comments.json', w.comments)
}

const sh = (args: string[], env: Record<string, string> = {}, skew = false) => {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${skew ? join(dir, 'skew') + ':' : ''}${join(dir, 'bin')}:${process.env.PATH}`,
      FAKE_DIR: fx,
      FAKE_T0: String(T0),
      MULTICA_CLI_PATH: join(dir, 'bin', 'multica'),
      ...env,
    },
  })
  const rd = (n: string) => (existsSync(join(fx, n)) ? readFileSync(join(fx, n), 'utf8') : '')
  return {
    ...r,
    out: r.stdout,
    err: r.stderr,
    writes: rd('writes'),
    log: rd('log'),
    mlog: rd('mlog'),
    dates: rd('dates').split('\n').filter(Boolean).map(Number),
  }
}
const planArgs = (head = MF, probes = PROBE_LIST) => [
  'plan',
  '--expect-head',
  head,
  '--probe-heads',
  probes,
  '--issue',
  ISSUE,
  '--admin-member',
  ADMIN,
]
const statusArgs = (...more: string[]) => ['status', '--issue', ISSUE, '--admin-member', ADMIN, ...more]
const plan = (w: World, head = MF, probes = PROBE_LIST) => {
  writeWorld(w)
  return sh(planArgs(head, probes))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freeze-'))
  fx = join(dir, 'fx')
  mkdirSync(fx)
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'skew'))
  writeFileSync(join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 })
  writeFileSync(join(dir, 'bin', 'multica'), FAKE_MULTICA, { mode: 0o755 })
  writeFileSync(join(dir, 'skew', 'date'), SKEW_DATE, { mode: 0o755 })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('plan: clean case', { timeout: 60_000 }, () => {
  it('exits 0, prints S0 with its bounds and passes every check', () => {
    const r = plan(freshWorld())
    expect(r.out + r.err).not.toContain('FAIL')
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/^S0 lo=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ hi=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ clean$/m)
    expect(r.writes).toBe('')
  })
  it('accepts the probe heads as a bare list in the fixed order', () => {
    writeWorld(freshWorld())
    const r = sh(planArgs(MF, PROBE_SHAS.join(',')))
    expect(r.status).toBe(0)
  })
})

describe('case 1: each failed precondition makes no write', { timeout: 60_000 }, () => {
  const expectFail = (r: ReturnType<typeof sh>, name: string) => {
    expect(r.status).toBe(2)
    expect(r.out).toContain(`FAIL ${name}`)
    expect(r.out).not.toMatch(/^S0 .* clean$/m)
    expect(r.writes).toBe('')
  }
  it('an open PR into main', () => {
    const w = freshWorld()
    writeWorld(w)
    put('pulls.json', [{ number: 92, base: { ref: 'main' }, state: 'open' }])
    expectFail(sh(planArgs()), 'open-prs')
  })
  it('a queue entry', () => {
    writeWorld(freshWorld())
    put('queue.json', {
      data: { repository: { mergeQueue: { entries: { totalCount: 1, nodes: [{ position: 1 }] } } } },
    })
    expectFail(sh(planArgs()), 'queue-entries')
  })
  it('a live group ref with 0 queue entries', () => {
    writeWorld(freshWorld())
    put('groups.json', [{ ref: 'refs/heads/gh-readonly-queue/main/pr-82-abc', object: { sha: OTHER } }])
    expectFail(sh(planArgs()), 'group-refs')
  })
  it('a head that is not M_f', () => {
    writeWorld(freshWorld())
    put('ref-main.json', { ref: 'refs/heads/main', object: { sha: OTHER } })
    expectFail(sh(planArgs()), 'head')
  })
  it('a head that cheese/main does not contain (ahead or diverged)', () => {
    for (const status of ['ahead', 'diverged']) {
      writeWorld(freshWorld())
      put('compare.json', { status })
      expectFail(sh(planArgs()), 'head-compare')
    }
  })
  it('a probe branch head that differs', () => {
    writeWorld(freshWorld())
    put('ref-freeze-probe-q-open.json', { object: { sha: OTHER } })
    expectFail(sh(planArgs()), 'probe-heads')
  })
  it('a probe head list with the wrong count', () => {
    writeWorld(freshWorld())
    expectFail(sh(planArgs(MF, PROBE_SHAS.slice(0, 3).join(','))), 'probe-heads')
  })
  it('a source ruleset with an update rule', () => {
    const w = freshWorld()
    w.rulesets = [S1, { ...S2, rules: [...S2.rules, { type: 'update' }] }]
    expectFail(plan(w), 'source-update')
  })
  it('a source ruleset with a main-frozen context is a foreign collision', () => {
    const w = freshWorld()
    w.rulesets = [
      {
        ...S1,
        rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: CTX }] } }],
      },
      S2,
    ]
    // the source set is derived from main, so a ruleset on main that requires the freeze context is a
    // foreign collision (plan: "any ruleset that is not ours and requires main-frozen"): exit 6, not 2
    const r = plan(w)
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/foreign: collision/)
    expect(r.writes).toBe('')
  })
  it('a workflow file that reports the main-frozen context', () => {
    writeWorld(freshWorld())
    put('wf-ci.yml', `name: x\njobs:\n  freeze:\n    name: ${CTX}\n    runs-on: ubuntu-latest\n`)
    expectFail(sh(planArgs()), 'workflow-context')
  })
  it('a read that fails the plan check (no PR list) is not read as clean', () => {
    writeWorld(freshWorld())
    rmSync(join(fx, 'pulls.json'))
    const r = sh(planArgs())
    expect(r.status).toBe(2)
    expect(r.out).not.toMatch(/^S0 .* clean$/m)
    expect(r.writes).toBe('')
  })
  it('an unreadable merge queue (mergeQueue null) is not read as 0 entries', () => {
    writeWorld(freshWorld())
    put('queue.json', { data: { repository: { mergeQueue: null } } })
    expectFail(sh(planArgs()), 'queue-entries')
  })
  it('an own active freeze from any nonce prints stale own and its rules do not count as source rules', () => {
    const w = freshWorld()
    const f = freezeDetail(111)
    w.rulesets = [S1, S2, f]
    w.comments = [intent(NONCE)]
    const r = plan(w)
    expect(r.status).toBe(2)
    expect(r.out).toContain(`stale own #${NONCE}`)
    expect(r.out).not.toContain('FAIL source-update')
    expect(r.out).not.toContain('FAIL source-context')
    expect(r.writes).toBe('')
  })
})

describe('case 2: bounds from GitHub server time only', { timeout: 60_000 }, () => {
  const trace = (err: string) =>
    err
      .split('\n')
      .filter((l) => l.startsWith('read '))
      .map((l) => {
        const [lo, hi] = boundsOf(l)
        return { lo: lo / 1000, hi: hi / 1000 }
      })
  it('lo of each read is the Date of the previous response; hi is its own Date + 1 s', () => {
    writeWorld(freshWorld())
    const r = sh(planArgs())
    expect(r.status).toBe(0)
    const t = trace(r.err)
    expect(t.length).toBe(r.dates.length)
    expect(t.length).toBeGreaterThan(8)
    t.forEach((b, i) => {
      expect(b.hi).toBe((r.dates[i] ?? NaN) + 1)
      expect(b.lo).toBe(r.dates[i === 0 ? 0 : i - 1])
    })
  })
  it('the first read is the clock read (rate_limit)', () => {
    writeWorld(freshWorld())
    const r = sh(planArgs())
    expect(r.log.split('\n')[0]).toContain('rate_limit')
  })
  it('a local clock that is 10 min off changes no bound', () => {
    writeWorld(freshWorld())
    const a = sh(planArgs())
    rmSync(join(fx, 'n'))
    rmSync(join(fx, 'dates'))
    rmSync(join(fx, 'log'))
    const b = sh(planArgs(), {}, true)
    expect(b.status).toBe(0)
    expect(b.out).toBe(a.out)
    expect(trace(b.err)).toEqual(trace(a.err))
    const [lo, hi] = boundsOf(b.out.split('\n').find((l) => l.startsWith('S0 ')) ?? '')
    expect(lo / 1000).toBeGreaterThanOrEqual(T0)
    expect(hi / 1000).toBeLessThan(T0 + 600)
  })
  it('the S0 bounds are [smallest lo, largest hi] of the 4 snapshot reads', () => {
    writeWorld(freshWorld())
    const r = sh(planArgs())
    const lines = r.err.split('\n').filter((l) => l.startsWith('read '))
    const snap = lines.filter((l) => /^read snapshot:/.test(l))
    expect(snap.length).toBe(4)
    const bs = snap.map(boundsOf)
    const s0 = boundsOf(r.out.split('\n').find((l) => l.startsWith('S0 ')) ?? '')
    expect(s0[0]).toBe(Math.min(...bs.map((b) => b[0])))
    expect(s0[1]).toBe(Math.max(...bs.map((b) => b[1])))
  })
  it('a response with no Date header is a failed read: exit 2, no clean S0', () => {
    writeWorld(freshWorld())
    const r = sh(planArgs(), { FAKE_NODATE: 'pulls' })
    expect(r.status).toBe(2)
    expect(r.err + r.out).toMatch(/no Date header/i)
    expect(r.out).not.toMatch(/^S0 .* clean$/m)
    expect(r.writes).toBe('')
  })
  it('a missing Date on the clock read fails the run', () => {
    writeWorld(freshWorld())
    const r = sh(planArgs(), { FAKE_NODATE: 'rate_limit' })
    expect(r.status).toBe(2)
    expect(r.out).not.toMatch(/^S0 .* clean$/m)
  })
})

describe('case 1b: the source set is read from main, not fixed', { timeout: 60_000 }, () => {
  it('a source ruleset that is not in any fixed list is a source: an update rule in it fails the plan', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, { ...S3, rules: [{ type: 'update' }] }]
    const r = plan(w)
    expect(r.status).toBe(2)
    expect(r.out).toContain('FAIL source-update')
  })
  it('a canonical mirror of a source that no fixed list names is own (stale own), not foreign', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, S3, mirrorDetail(222, NONCE, S3)]
    w.comments = [intent(NONCE)]
    const r = plan(w)
    expect(r.status).toBe(2)
    expect(r.out).toContain(`stale own #${NONCE}`)
    expect(r.out).not.toMatch(/foreign/)
  })
  it('a mirror of a ruleset that main does not list is foreign (unknown source)', () => {
    const w = freshWorld()
    const off = { ...S3, conditions: { ref_name: { include: ['refs/heads/other'], exclude: [] } } }
    w.rulesets = [S1, S2, off, mirrorDetail(222, NONCE, off)]
    w.comments = [intent(NONCE)]
    const r = plan(w)
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/unknown-source/)
  })
  it('a source listed on main with no readable repository ruleset fails the plan', () => {
    const w = freshWorld()
    w.rules = [
      ...ruleRows(S1),
      ...ruleRows(S2),
      { type: 'deletion', ruleset_id: 999, ruleset_source_type: 'Organization' },
    ]
    const r = plan(w)
    expect(r.status).toBe(2)
    expect(r.out).toContain('FAIL source-detail')
  })
  it('--source-ids is gone', () => {
    writeWorld(freshWorld())
    const r = sh([...planArgs(), '--source-ids', '1'])
    expect(r.status).toBe(64)
  })
})

describe('case 1c: every own ruleset in play is stale or foreign', { timeout: 60_000 }, () => {
  const own = (d: J, kind = 'merge-fence') => {
    const w = freshWorld()
    w.rulesets = [S1, S2, d]
    w.comments = [intent(NONCE, kind)]
    return plan(w)
  }
  it.each([
    ['head pin', pinOwn(120), 'pin'],
    ['merge fence', fenceDetail(121), 'fence'],
    ['merge actor', actorDetail(122), 'actor'],
  ])('an own active %s is stale own, and its rules do not count as source rules', (_n, d, kind) => {
    const r = own(d)
    expect(r.status).toBe(2)
    expect(r.out).toContain(`stale own #${NONCE} (${kind} ruleset ${d.id})`)
    expect(r.out).not.toContain('FAIL source-update')
    expect(r.writes).toBe('')
  })
  it.each([
    ['fence', fenceDetail(121, 'deadbeef')],
    ['actor', actorDetail(122, 'deadbeef')],
    ['fence with a bypass actor', fenceDetail(121, NONCE, { bypass_actors: actorDetail(1).bypass_actors })],
    [
      'actor with two bypass actors',
      actorDetail(122, NONCE, {
        bypass_actors: [...actorDetail(1).bypass_actors, { actor_id: 7, actor_type: 'User', bypass_mode: 'always' }],
      }),
    ],
    [
      'actor with a team actor',
      actorDetail(122, NONCE, { bypass_actors: [{ actor_id: 7, actor_type: 'Team', bypass_mode: 'pull_request' }] }),
    ],
  ])('a foreign %s ends in exit 6', (_n, d) => {
    const r = own(d)
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/foreign/)
    expect(r.writes).toBe('')
  })
})

describe('case 3: foreign collision gives exit 6 with no write', { timeout: 60_000 }, () => {
  const expectForeign = (w: World) => {
    const r = plan(w)
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/foreign/)
    expect(r.out).not.toMatch(/^S0 .* clean$/m)
    expect(r.writes).toBe('')
    return r
  }
  it('a #deadbeef ruleset with no intent record', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, freezeDetail(111, 'deadbeef')]
    expectForeign(w)
  })
  it('our nonce and an intent record, with an added bypass actor', () => {
    const w = freshWorld()
    w.rulesets = [
      S1,
      S2,
      freezeDetail(111, NONCE, {
        bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
      }),
    ]
    w.comments = [intent(NONCE)]
    expectForeign(w)
  })
  it('a mirror-prefixed ruleset whose source id is unknown', () => {
    const w = freshWorld()
    const unknownSrc = { ...S1, id: 999 }
    w.rulesets = [S1, S2, mirrorDetail(222, NONCE, unknownSrc)]
    w.comments = [intent(NONCE)]
    expectForeign(w)
  })
  it('another ruleset that requires the main-frozen context', () => {
    const w = freshWorld()
    w.rulesets = [
      S1,
      S2,
      sourceDetail(300, 'someone elses gate', [
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: CTX }] } },
      ]),
    ]
    expectForeign(w)
  })
  it('a ruleset that includes a freeze-probe or guard-rehearsal ref', () => {
    for (const ref of ['refs/heads/freeze-probe/q-open', 'refs/heads/guard-rehearsal/x']) {
      const w = freshWorld()
      w.rulesets = [
        S1,
        S2,
        {
          ...sourceDetail(301, 'rehearsal', [{ type: 'deletion' }]),
          conditions: { ref_name: { include: [ref], exclude: [] } },
        },
      ]
      expectForeign(w)
    }
  })
  it('an intent record by another author, or for another nonce', () => {
    for (const comments of [[intent(NONCE, 'freeze', 'someone-else')], [intent('0badf00d')]]) {
      const w = freshWorld()
      w.rulesets = [S1, S2, freezeDetail(111)]
      w.comments = comments
      expectForeign(w)
    }
  })
  it('a name with our prefix and a bad nonce', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, freezeDetail(111, 'zzz', {})]
    w.comments = [intent('zzz')]
    expectForeign(w)
  })
  it('a freeze whose include list differs (shape not canonical)', () => {
    const w = freshWorld()
    const f = freezeDetail(111)
    f.conditions.ref_name.include = ['refs/heads/main']
    w.rulesets = [S1, S2, f]
    w.comments = [intent(NONCE)]
    expectForeign(w)
  })
  it('a canonical own ruleset is not foreign even with defaults GitHub adds', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, freezeDetail(111, NONCE, { extra_default: true })]
    w.comments = [intent(NONCE)]
    const r = plan(w)
    expect(r.status).toBe(2)
    expect(r.out).toContain(`stale own #${NONCE}`)
  })
  it('a canonical mirror of a current source is own (stale own)', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, mirrorDetail(222, NONCE, S1)]
    w.comments = [intent(NONCE)]
    const r = plan(w)
    expect(r.status).toBe(2)
    expect(r.out).toContain(`stale own #${NONCE}`)
  })
  it('a mirror whose rules differ from its source is foreign', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, mirrorDetail(222, NONCE, S1, { rules: [{ type: 'deletion' }] })]
    w.comments = [intent(NONCE)]
    expectForeign(w)
  })
  it('an unrelated ruleset is ignored', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, sourceDetail(400, 'protect cheese/main', [{ type: 'deletion' }])]
    const r = plan(w)
    expect(r.status).toBe(0)
  })
  it('status prints the ownership result and does not fail on a foreign ruleset', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, freezeDetail(111, 'deadbeef')]
    writeWorld(w)
    const r = sh(statusArgs())
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/ruleset 111 .*owner=foreign/)
    expect(r.writes).toBe('')
  })
})

describe('ruleset-owner.sh unit', { timeout: 60_000 }, () => {
  const own = (detail: J, comments: J[], sources = '26093168,27606879', extraDetails: J[] = []) => {
    writeFileSync(join(dir, 'd.json'), JSON.stringify(detail))
    writeFileSync(join(dir, 'c.json'), JSON.stringify(comments))
    mkdirSync(join(dir, 'rs'), { recursive: true })
    for (const d of [S1, S2, ...extraDetails]) writeFileSync(join(dir, 'rs', `${d.id}.json`), JSON.stringify(d))
    const r = spawnSync(
      'bash',
      [
        '-c',
        `source "${LIB('ruleset-owner.sh')}"; RO_DETAIL_DIR="${dir}/rs" ro_classify "${dir}/d.json" "${dir}/c.json" "${ADMIN}" "${sources}"`,
      ],
      { encoding: 'utf8' },
    )
    return r.stdout.trim()
  }
  const pinDetail = (over: J = {}): J => ({
    id: 5,
    name: `port head pin (CHE-7309) #${NONCE}`,
    target: 'branch',
    source_type: 'Repository',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/agent/x'], exclude: [] } },
    rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
    ...over,
  })
  it('a canonical freeze is own', () => expect(own(freezeDetail(1), [intent(NONCE)])).toBe(`own freeze ${NONCE}`))
  it('a canonical mirror is own and names its source', () =>
    expect(own(mirrorDetail(2, NONCE, S1), [intent(NONCE)])).toBe(`own mirror ${NONCE} source=26093168`))
  it('a mirror needs the source in the current set or the pin record', () => {
    expect(own(mirrorDetail(2, NONCE, S1), [intent(NONCE)], '27606879')).toMatch(/^foreign unknown-source/)
    expect(own(mirrorDetail(2, NONCE, S1), [intent(NONCE)], '27606879,26093168')).toMatch(/^own mirror/)
  })
  it('a mirror whose enforcement or bypass list differs from its source is foreign', () => {
    expect(own(mirrorDetail(2, NONCE, S1, { enforcement: 'evaluate' }), [intent(NONCE)])).toMatch(/^foreign bad-shape/)
    expect(
      own(mirrorDetail(2, NONCE, S1, { bypass_actors: [{ actor_id: 1, actor_type: 'User', bypass_mode: 'always' }] }), [
        intent(NONCE),
      ]),
    ).toMatch(/^foreign bad-shape/)
  })
  it('one changed rule parameter makes a mirror foreign', () => {
    const rules = JSON.parse(JSON.stringify(S1.rules))
    rules[1].parameters.check_response_timeout_minutes = 61
    expect(own(mirrorDetail(2, NONCE, S1, { rules }), [intent(NONCE)])).toMatch(/^foreign bad-shape/)
  })
  it('unreadable bypass actors (null) fail closed', () => {
    expect(own(freezeDetail(1, NONCE, { bypass_actors: null }), [intent(NONCE)])).toMatch(/^foreign bad-shape.*bypass/)
  })
  it('the intent kind must match: a merge-fence intent does not own a freeze', () => {
    expect(own(freezeDetail(1), [intent(NONCE, 'merge-fence')])).toMatch(/^foreign no-intent/)
  })
  it('the intent line must be a whole line starting with the kind', () => {
    const c = { ...intent(NONCE), content: `see freeze-intent v1 nonce=${NONCE} op=apply` }
    expect(own(freezeDetail(1), [c])).toMatch(/^foreign no-intent/)
  })
  it('a freeze with an extra rule, a different context, or strict policy on is foreign', () => {
    const extra = freezeDetail(1)
    extra.rules.push({ type: 'pull_request' })
    expect(own(extra, [intent(NONCE)])).toMatch(/^foreign bad-shape/)
    const ctx = freezeDetail(1)
    ctx.rules[3].parameters.required_status_checks = [{ context: 'other' }]
    expect(own(ctx, [intent(NONCE)])).toMatch(/^foreign bad-shape/)
    const strict = freezeDetail(1)
    strict.rules[3].parameters.strict_required_status_checks_policy = true
    expect(own(strict, [intent(NONCE)])).toMatch(/^foreign bad-shape/)
  })
  it('a canonical head pin is own under a merge-fence intent', () =>
    expect(own(pinDetail(), [intent(NONCE, 'merge-fence')])).toBe(`own pin ${NONCE}`))
  it('a head pin with a bypass actor is foreign', () =>
    expect(
      own(pinDetail({ bypass_actors: [{ actor_id: 1, actor_type: 'User', bypass_mode: 'always' }] }), [
        intent(NONCE, 'merge-fence'),
      ]),
    ).toMatch(/^foreign bad-shape/))
  it('a canonical merge fence is own under a merge-fence intent', () =>
    expect(own(fenceDetail(6), [intent(NONCE, 'merge-fence')])).toBe(`own fence ${NONCE}`))
  it('a canonical merge actor is own under a merge-fence intent', () =>
    expect(own(actorDetail(7), [intent(NONCE, 'merge-fence')])).toBe(`own actor ${NONCE}`))
  it('a fence or actor needs a merge-fence intent for its own nonce', () => {
    expect(own(fenceDetail(6), [intent(NONCE, 'freeze')])).toMatch(/^foreign no-intent/)
    expect(own(actorDetail(7), [intent('deadbeef', 'merge-fence')])).toMatch(/^foreign no-intent/)
  })
  it('a fence with another context, no strict policy, other merge methods or an approval count is foreign', () => {
    const ctx = fenceDetail(6)
    ctx.rules[0].parameters.required_status_checks.pop()
    expect(own(ctx, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape rules/)
    const strict = fenceDetail(6)
    strict.rules[0].parameters.strict_required_status_checks_policy = false
    expect(own(strict, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape rules/)
    const methods = fenceDetail(6)
    methods.rules[1].parameters.allowed_merge_methods = ['merge', 'squash']
    expect(own(methods, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape rules/)
    const approvals = fenceDetail(6)
    approvals.rules[1].parameters.required_approving_review_count = 1
    expect(own(approvals, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape rules/)
  })
  it('a fence or actor on more than one ref, or off refs/heads, is foreign', () => {
    const two = fenceDetail(6, NONCE, {
      conditions: { ref_name: { include: [BASE_REF, 'refs/heads/main'], exclude: [] } },
    })
    expect(own(two, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape include/)
    const tag = actorDetail(7, NONCE, { conditions: { ref_name: { include: ['refs/tags/v1'], exclude: [] } } })
    expect(own(tag, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape include/)
  })
  it('an actor with an extra rule, a wrong mode or an evaluate enforcement is foreign', () => {
    const rule = actorDetail(7, NONCE, { rules: [{ type: 'update' }, { type: 'deletion' }] })
    expect(own(rule, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape rules/)
    const mode = actorDetail(7, NONCE, { bypass_actors: [{ actor_id: 1, actor_type: 'User', bypass_mode: 'always' }] })
    expect(own(mode, [intent(NONCE, 'merge-fence')])).toMatch(/^foreign bad-shape bypass_actors/)
    expect(own(actorDetail(7, NONCE, { enforcement: 'evaluate' }), [intent(NONCE, 'merge-fence')])).toMatch(
      /^foreign bad-shape enforcement/,
    )
  })
  it('ro_has_prefix knows all five prefixes', () => {
    for (const p of [
      'freeze main (CHE-7309) #x',
      'port merge fence (CHE-7309) #x',
      'port merge actor (CHE-7309) #x',
      'port head pin (CHE-7309) #x',
      'freeze probe mirror (CHE-7309) #x',
    ]) {
      const r = spawnSync('bash', ['-c', `source "${LIB('ruleset-owner.sh')}"; ro_has_prefix "${p}"`])
      expect(r.status, p).toBe(0)
    }
  })
  it('a non-prefixed ruleset is other', () =>
    expect(own(sourceDetail(9, 'protect cheese/main', [{ type: 'deletion' }]), [])).toBe('other'))
})

describe('case 4: refusal table', { timeout: 60_000 }, () => {
  const NO_UPDATE = '{"has_update":false,"has_freeze_context":false}'
  const cls = (mode: string, value: string, facts = '') => {
    const r = spawnSync(
      'bash',
      ['-c', `source "${LIB('freeze-classify.sh')}"; fc_classify "$1" "$2" "$3"`, 'x', mode, value, facts],
      { encoding: 'utf8' },
    )
    return r.stdout.trim()
  }
  it.each([
    ['branch_protections', 'queue-removal'],
    ['checks_timed_out', 'queue-removal'],
    ['ci_timeout', 'queue-removal'],
    ...[
      'merge_conflict',
      'manual',
      'manually_removed',
      'ci_failure',
      'checks_failed',
      'failed_checks',
      'queue_cleared',
      'already_merged',
      'merged',
      'git_tree_invalid',
      'invalid_merge_commit',
      'roll_back',
      'draft',
      'conflict',
      'closed',
    ].map((v) => [v, 'unrelated']),
    ['FAILED_CHECKS', 'unrelated'],
    ['Merged', 'unrelated'],
    ['', 'unknown'],
    ['null', 'unknown'],
    ['timeout', 'unknown'],
    ['HTTP 503', 'unknown'],
    ['rate limit exceeded', 'unknown'],
    ['some_new_reason', 'unknown'],
  ])('reason %j is %s', (v, want) => expect(cls('reason', v)).toBe(want))

  it.each([
    ['Repository rule violations found', 'generic-rule'],
    ['GH013: Repository rule violations found for refs/heads/main.', 'generic-rule'],
    ['required status check "build" is expected', 'generic-rule'],
    ['Required status check is expected', 'generic-rule'],
    ['Changes must be made through the merge queue', 'generic-rule'],
    ['At least 1 approving review is required by reviewers with write access', 'generic-rule'],
    ['', 'unknown'],
    ['null', 'unknown'],
    ['HTTP 504: Gateway Timeout', 'unknown'],
    ['HTTP 502', 'unknown'],
    ['context deadline exceeded (timeout)', 'unknown'],
    ['API rate limit exceeded', 'unknown'],
    ['a text nobody listed', 'unknown'],
  ])('text %j is %s', (v, want) => expect(cls('text', v, NO_UPDATE)).toBe(want))

  it('a text that names main-frozen is freeze-specific only with pin facts that show no update rule and no such context', () => {
    const t = 'Required status check "main-frozen (CHE-7309)" is expected.'
    expect(cls('text', t, NO_UPDATE)).toBe('freeze-specific')
    expect(cls('text', t.toUpperCase(), NO_UPDATE)).toBe('freeze-specific')
    expect(cls('text', t)).toBe('generic-rule')
    expect(cls('text', t, '{"has_update":true,"has_freeze_context":false}')).toBe('generic-rule')
    expect(cls('text', t, '{"has_update":false,"has_freeze_context":true}')).toBe('generic-rule')
    expect(cls('text', t, 'not json')).toBe('generic-rule')
  })
  it('"cannot update this protected ref" is freeze-specific under the same facts', () => {
    const t =
      'GH013: Repository rule violations found for refs/heads/freeze-probe/d-frozen.\n\n- Cannot update this protected ref.'
    expect(cls('text', t, NO_UPDATE)).toBe('freeze-specific')
    expect(cls('text', t)).toBe('generic-rule')
    expect(cls('text', t, '{"has_update":true,"has_freeze_context":false}')).toBe('generic-rule')
  })
  it('only freeze-specific passes a direct or immediate enqueue refusal', () => {
    for (const [c, ok] of [
      ['freeze-specific', 0],
      ['generic-rule', 1],
      ['queue-removal', 1],
      ['unrelated', 1],
      ['unknown', 1],
    ] as const) {
      const r = spawnSync('bash', ['-c', `source "${LIB('freeze-classify.sh')}"; fc_passes_direct "$1"`, 'x', c])
      expect(r.status).toBe(ok)
    }
  })
  it('fc_pin_facts reads has_update and has_freeze_context from a rule list', () => {
    const facts = (rules: J[]) => {
      writeFileSync(join(dir, 'r.json'), JSON.stringify(rules))
      return JSON.parse(
        spawnSync('bash', ['-c', `source "${LIB('freeze-classify.sh')}"; fc_pin_facts "${dir}/r.json"`], {
          encoding: 'utf8',
        }).stdout,
      )
    }
    expect(facts([{ type: 'deletion' }])).toEqual({ has_update: false, has_freeze_context: false })
    expect(facts([{ type: 'update' }])).toEqual({ has_update: true, has_freeze_context: false })
    expect(
      facts([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: CTX }] } }]),
    ).toEqual({ has_update: false, has_freeze_context: true })
  })
})

describe('case 5: normalization', { timeout: 60_000 }, () => {
  const rulesA: J[] = [
    { type: 'non_fast_forward', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'cheese-work/doop' },
    {
      type: 'merge_queue',
      parameters: { check_response_timeout_minutes: 60, grouping_strategy: 'ALLGREEN' },
      ruleset_id: 1,
      ruleset_source_type: 'Repository',
      ruleset_source: 'cheese-work/doop',
    },
    { type: 'deletion', ruleset_id: 2, ruleset_source_type: 'Repository', ruleset_source: 'cheese-work/doop' },
  ]
  const hash = (rules: J[], extra: string[] = []) => {
    writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules))
    const r = sh(['policy-hash', '--rules-file', join(dir, 'rules.json'), ...extra])
    expect(r.status).toBe(0)
    expect(r.out.trim()).toMatch(/^[0-9a-f]{64}$/)
    return r.out.trim()
  }
  it('rule lists that differ only by ruleset id, source or order give the same hash', () => {
    const b = rulesA.map((r, i) => ({ ...r, ruleset_id: 900 + i, ruleset_source: 'other' })).reverse()
    expect(hash(b)).toBe(hash(rulesA))
  })
  it('key order inside parameters does not change the hash', () => {
    const b = JSON.parse(JSON.stringify(rulesA))
    b[1].parameters = { grouping_strategy: 'ALLGREEN', check_response_timeout_minutes: 60 }
    expect(hash(b)).toBe(hash(rulesA))
  })
  it('one changed parameter gives another hash', () => {
    const b = JSON.parse(JSON.stringify(rulesA))
    b[1].parameters.check_response_timeout_minutes = 61
    expect(hash(b)).not.toBe(hash(rulesA))
  })
  it('a different rule type gives another hash', () =>
    expect(hash([...rulesA, { type: 'update', ruleset_id: 3 }])).not.toBe(hash(rulesA)))
  it('the rules of our freeze are left out', () => {
    const withFreeze = [...rulesA, ...freezeRules().map((r) => ({ ...r, ruleset_id: 111 }))]
    expect(hash(withFreeze, ['--freeze-id', '111'])).toBe(hash(rulesA))
    expect(hash(withFreeze)).not.toBe(hash(rulesA))
  })
  it('Pm adds each source id, updated_at and bypass list', () => {
    const src = (over: J = {}) => [
      { id: 1, updated_at: '2026-11-19T10:04:00Z', bypass_actors: [] },
      { id: 2, updated_at: '2026-11-19T10:04:00Z', bypass_actors: null, ...over },
    ]
    const pm = (s: J[]) => {
      writeFileSync(join(dir, 'src.json'), JSON.stringify(s))
      return hash(rulesA, ['--sources-file', join(dir, 'src.json')])
    }
    expect(pm(src())).not.toBe(hash(rulesA))
    expect(pm(src())).toBe(pm(src()))
    expect(pm(src({ updated_at: '2026-11-19T10:05:00Z' }))).not.toBe(pm(src()))
    expect(pm(src({ bypass_actors: [{ actor_id: 1, actor_type: 'User', bypass_mode: 'always' }] }))).not.toBe(pm(src()))
    expect(pm([...src()].reverse())).toBe(pm(src()))
  })
})

describe('case 6: plan and status make no write call of any kind', { timeout: 60_000 }, () => {
  const rich = (): World => {
    const w = freshWorld()
    w.rulesets = [
      S1,
      S2,
      freezeDetail(111),
      mirrorDetail(222, NONCE, S1),
      mirrorDetail(223, NONCE, S2),
      freezeDetail(112, 'deadbeef'),
    ]
    w.comments = [intent(NONCE)]
    return w
  }
  it('plan', () => {
    const r = plan(rich())
    expect(r.writes).toBe('')
    expect(r.log).not.toMatch(/(^| )(-X|--method) (POST|PUT|PATCH|DELETE)/m)
    expect(r.log).not.toMatch(/--input/)
    expect(r.mlog).not.toMatch(/comment add|status|create|update/)
  })
  it('status', () => {
    writeWorld(rich())
    const r = sh(statusArgs())
    expect(r.status).toBe(0)
    expect(r.writes).toBe('')
    expect(r.log).not.toMatch(/(^| )(-X|--method) (POST|PUT|PATCH|DELETE)/m)
    expect(r.mlog).not.toMatch(/comment add|status|create|update/)
  })
})

describe('status', { timeout: 60_000 }, () => {
  const world = (): World => {
    const w = freshWorld()
    w.rulesets = [S1, S2, freezeDetail(111), mirrorDetail(222, NONCE, S1), freezeDetail(112, 'deadbeef')]
    w.comments = [intent(NONCE)]
    return w
  }
  it('prints rules on main and the 4 probe refs with their ruleset ids', () => {
    writeWorld(world())
    const r = sh(statusArgs())
    expect(r.out).toMatch(/^rules main:/m)
    expect(r.out).toMatch(/ruleset=26093168 type=merge_queue/)
    for (const n of PROBE_NAMES) expect(r.out).toContain(`rules freeze-probe/${n}:`)
    expect(r.out).toMatch(/rules freeze-probe\/q-frozen:[\s\S]*ruleset=111 type=update/)
  })
  it('prints every ruleset with our prefixes with its ownership result', () => {
    writeWorld(world())
    const r = sh(statusArgs())
    expect(r.out).toMatch(
      new RegExp(`ruleset 111 name="freeze main \\(CHE-7309\\) #${NONCE}" owner=own kind=freeze nonce=${NONCE}`),
    )
    expect(r.out).toMatch(/ruleset 222 .*owner=own kind=mirror .*source=26093168/)
    expect(r.out).toMatch(/ruleset 112 .*owner=foreign reason=no-intent/)
  })
  it('prints current_user_can_bypass for each source, mirror and freeze', () => {
    writeWorld(world())
    const r = sh(statusArgs())
    expect(r.out).toMatch(/ruleset 26093168 .*role=source .*current_user_can_bypass=pull_requests_only/)
    expect(r.out).toMatch(/ruleset 27606879 .*role=source .*current_user_can_bypass=pull_requests_only/)
    expect(r.out).toMatch(/ruleset 222 .*current_user_can_bypass=never/)
    expect(r.out).toMatch(/ruleset 111 .*current_user_can_bypass=never/)
  })
  it('prints the normalized policy hash of main and of each probe ref (our freeze left out)', () => {
    writeWorld(world())
    const r = sh(statusArgs())
    expect(r.out).toMatch(/^policy main sha256=[0-9a-f]{64}$/m)
    for (const n of PROBE_NAMES)
      expect(r.out).toMatch(new RegExp(`^policy freeze-probe/${n} sha256=[0-9a-f]{64}$`, 'm'))
    expect(r.out).toMatch(/^Pm sha256=[0-9a-f]{64}$/m)
    // the freeze is left out, so main's hash equals the hash of the source rules alone
    const clean = world()
    clean.rulesets = [S1, S2]
    writeWorld(clean)
    const base = /^policy main sha256=(\S+)/m.exec(sh(statusArgs()).out)![1]
    writeWorld(world())
    expect(/^policy main sha256=(\S+)/m.exec(sh(statusArgs()).out)![1]).toBe(base)
  })
  const pmOf = (rulesets: J[]) => {
    const w = freshWorld()
    w.rulesets = rulesets
    writeWorld(w)
    const r = sh(statusArgs())
    expect(r.status).toBe(0)
    return /^Pm sha256=(\S+)/m.exec(r.out)![1]
  }
  it('Pm covers a source that no fixed list names: its bypass actors and updated_at change Pm', () => {
    const base = pmOf([S1, S2, S3])
    expect(base).not.toBe(pmOf([S1, S2]))
    const bypass = { ...S3, bypass_actors: [{ actor_id: 6, actor_type: 'RepositoryRole', bypass_mode: 'always' }] }
    expect(pmOf([S1, S2, bypass])).not.toBe(base)
    expect(pmOf([S1, S2, { ...S3, updated_at: '2026-11-22T00:00:00Z' }])).not.toBe(base)
    expect(pmOf([S1, S2, S3])).toBe(base)
  })
  it('lists a derived source as role=source', () => {
    const w = freshWorld()
    w.rulesets = [S1, S2, S3]
    writeWorld(w)
    expect(sh(statusArgs()).out).toMatch(/ruleset 28000001 .*role=source .*current_user_can_bypass=pull_requests_only/)
  })
  it('a source listed on main with no readable repository ruleset gives no Pm and exit 2', () => {
    const w = freshWorld()
    w.rules = [
      ...ruleRows(S1),
      ...ruleRows(S2),
      { type: 'deletion', ruleset_id: 999, ruleset_source_type: 'Organization' },
    ]
    writeWorld(w)
    const r = sh(statusArgs())
    expect(r.status).toBe(2)
    expect(r.out).toContain('FAIL source-detail')
    expect(r.out).not.toMatch(/^Pm sha256=/m)
  })
  it('--nonce narrows the ownership listing to one nonce', () => {
    writeWorld(world())
    const r = sh(statusArgs('--nonce', NONCE))
    expect(r.out).toMatch(/ruleset 111 /)
    expect(r.out).not.toMatch(/ruleset 112 /)
    const none = sh(statusArgs('--nonce', 'ffffffff'))
    expect(none.out).toMatch(/nonce ffffffff: no rulesets/)
  })
})

describe('arguments', () => {
  it('plan without --expect-head is a usage error with no read', () => {
    writeWorld(freshWorld())
    const r = sh(['plan', '--probe-heads', PROBE_LIST, '--issue', ISSUE, '--admin-member', ADMIN])
    expect(r.status).toBe(64)
    expect(r.log).toBe('')
  })
  it('an unknown command is a usage error', () => {
    expect(sh(['apply']).status).toBe(64)
  })
})
