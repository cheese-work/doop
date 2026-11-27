#!/usr/bin/env node
// Static preflight over the CD files (CHE-9963, CHE-9850 S3). It reads files and prints findings; it writes
// nothing and calls no API. Every rule is a pure function of file text, so a fixture can fail each one.
//
//   node scripts/cd-preflight.mjs        exit 0: no finding. Exit 1: findings on stdout, one per line.
//   node scripts/cd-preflight.mjs --ref <rev>   the same over the files at a git revision (a PR head fetched, not checked
//                                        out: cd-preflight.yml reads it as data). actionlint still uses this tree's config.
//
// Rules: actionlint, app-token, token-input, environment, vars, mergers, runner-labels, c00-paths, cron-slots.
// A rule that cannot read what it needs reports a finding: it never passes by default.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKFLOW_DIR = '.github/workflows'
const DEPLOY_YML = `${WORKFLOW_DIR}/cd-deploy.yml`
const README = 'deploy/cd/README.md'
const PATHS_LIST = 'deploy/cd/c00-paths.list'
const GATE = 'scripts/deploy-gate.mjs'
const WATCH = 'scripts/cd-watch.mjs'
const ACTIONLINT_CONFIG = '.github/actionlint.yaml'

// The merge bot's login as GitHub reports it in `merged_by.login`: the App slug plus `[bot]` (CHE-9781).
export const MERGE_BOT_LOGIN = 'congvc-bot-x99[bot]'
// The two runners CD uses. The C00 deploy jobs take exactly the first; the live watcher runs on the second.
export const C00_RUNNER = ['self-hosted', 'cheese-c00-deploy']
export const KNOWN_SELF_HOSTED = ['cheese-c00-deploy', 'cheese-x99-gate']
// Where a C00 script may read or write. A list entry outside these is a finding.
export const ALLOWED_PATH_PREFIXES = [
  '/var/lib/doop-deploy',
  '/var/lib/docker',
  '/var/lock/',
  '/home/congvc/.local/share/doop',
]
// Files whose absolute C00 paths must be listed (the workflows are added from the files given).
export const SCRIPT_FILES = [
  'deploy/cd/c00.sh',
  'scripts/deploy-marker.mjs',
  'scripts/deploy-lift.mjs',
  'scripts/deploy-gate.mjs',
  'scripts/deploy-smoke.mjs',
  'scripts/deploy-evidence.mjs',
  'scripts/cd-watch.mjs',
]

const finding = (rule, file, message, line) => (line ? { rule, file, line, message } : { rule, file, message })
export const formatFinding = (f) => `${f.file}${f.line ? `:${f.line}` : ''}: [${f.rule}] ${f.message}`

const isWorkflow = (p) => /^\.github\/workflows\/cd-[^/]+\.ya?ml$/.test(p)
export const workflows = (files) => Object.keys(files).filter(isWorkflow).sort()
// Full-line comments only (`#` for yaml and shell, `//` for scripts): an inline `#` may sit inside a string.
export const stripComments = (text) => String(text ?? '').replace(/^[ \t]*(#|\/\/).*$/gm, '')
const lineOf = (text, index) => text.slice(0, index).split('\n').length

export function checkNoAppToken(files) {
  const out = []
  for (const p of workflows(files)) {
    const text = stripComments(files[p])
    const m = /create-github-app-token/.exec(text)
    if (m)
      out.push(
        finding(
          'app-token',
          p,
          'create-github-app-token is not allowed: CD holds no GitHub App (CHE-9877)',
          lineOf(text, m.index),
        ),
      )
  }
  return out
}

// Failure class 5: the token asked for `variables`; the input is `permission-actions-variables`.
export function checkTokenInput(files) {
  const out = []
  for (const p of workflows(files)) {
    const text = stripComments(files[p])
    for (const m of text.matchAll(/^\s*permission-variables\s*:/gm)) {
      out.push(
        finding(
          'token-input',
          p,
          'permission-variables is not an input: use permission-actions-variables',
          lineOf(text, m.index),
        ),
      )
    }
  }
  return out
}

const unquote = (s) =>
  s
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim()

// The first cell and the backticked name of every README table row.
export function readmeRows(readme) {
  const rows = []
  for (const line of String(readme ?? '').split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    const name = /^`([^`]+)`/.exec(cells[1] ?? '')?.[1]
    if (cells[0] && name) rows.push({ kind: cells[0].toLowerCase(), name, text: cells.slice(2).join(' ') })
  }
  return rows
}

// Every `environment:` a CD workflow names: `{ file, line, value, raw }`. `value` is '' when it is not a literal name.
export function environmentRefs(files) {
  const out = []
  for (const p of workflows(files)) {
    const text = stripComments(files[p])
    for (const m of text.matchAll(/^([ \t]*)environment:[ \t]*(.*)$/gm)) {
      const line = lineOf(text, m.index)
      let value = unquote(m[2] ?? '')
      if (value.startsWith('{')) value = unquote(/\bname:\s*([^,}]+)/.exec(value)?.[1] ?? '')
      else if (!value) {
        const indent = (m[1] ?? '').length
        for (const next of text.slice(m.index + m[0].length + 1).split('\n')) {
          if (!next.trim()) continue
          if (next.length - next.trimStart().length <= indent) break
          const n = /^\s*name:\s*(.+)$/.exec(next)
          if (n) {
            value = unquote(n[1] ?? '')
            break
          }
        }
      }
      out.push({ file: p, line, value: value.includes('${{') ? '' : value, raw: m[2] || '(block)' })
    }
  }
  return out
}

export function checkEnvironments(files) {
  const listed = new Set(
    readmeRows(files[README])
      .filter((r) => r.kind === 'environment')
      .map((r) => r.name),
  )
  const out = []
  for (const r of environmentRefs(files)) {
    if (!r.value) out.push(finding('environment', r.file, `environment is not a literal name: ${r.raw}`, r.line))
    else if (!listed.has(r.value))
      out.push(finding('environment', r.file, `environment ${r.value} is not an Environment row in ${README}`, r.line))
  }
  return out
}

// Every `vars.NAME` a CD workflow reads: `{ file, line, name, fallback }`, `fallback` when `||` follows it.
export function varRefs(files) {
  const out = []
  for (const p of workflows(files)) {
    const text = stripComments(files[p])
    for (const m of text.matchAll(/\bvars\.([A-Za-z_][A-Za-z0-9_]*)(\s*\|\|)?/g))
      out.push({ file: p, line: lineOf(text, m.index), name: m[1], fallback: Boolean(m[2]) })
  }
  return out
}

export function checkVars(files) {
  const rows = new Map(
    readmeRows(files[README])
      .filter((r) => /\bvar(iable)?\b/.test(r.kind))
      .map((r) => [r.name, /\boptional\b/i.test(r.text)]),
  )
  const out = []
  const seen = new Set()
  for (const { file: p, line, name, fallback } of varRefs(files)) {
    if (!rows.has(name)) {
      if (!seen.has(`${p}:${name}`))
        out.push(finding('vars', p, `vars.${name} is not a variable row in ${README}`, line))
      seen.add(`${p}:${name}`)
    } else if (fallback && !rows.get(name)) {
      out.push(finding('vars', p, `vars.${name} has a fallback, so ${README} must mark it optional`, line))
    }
  }
  return out
}

// Failure class 6: the allowlist missed `congvc-bot-x99[bot]`. Only an exact quoted login counts.
export function checkMergers(files) {
  const src = stripComments(files[GATE])
  const m = /\bconst\s+MERGERS\s*=\s*new\s+Set\(\s*\[((?:'[^']*'|"[^"]*"|[^\]'"])*)\]\s*\)/.exec(src)
  if (!m) return [finding('mergers', GATE, 'cannot find `const MERGERS = new Set([...])`')]
  const logins = [...(m[1] ?? '').matchAll(/(['"])(.*?)\1/g)].map((x) => x[2])
  if (logins.includes(MERGE_BOT_LOGIN)) return []
  return [finding('mergers', GATE, `MERGERS must hold the exact login ${MERGE_BOT_LOGIN}`, lineOf(src, m.index))]
}

function parseRunsOn(raw) {
  const v = raw.trim()
  if (!v || v.startsWith('{')) return null
  if (v.startsWith('['))
    return v
      .replace(/^\[|\]\s*$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean)
  return [unquote(v)]
}

export function checkRunnerLabels(files) {
  const out = []
  for (const p of workflows(files)) {
    const text = stripComments(files[p])
    const c00Only = p === DEPLOY_YML
    for (const m of text.matchAll(/^[ \t]*runs-on:[ \t]*(.*)$/gm)) {
      const line = lineOf(text, m.index)
      const labels = parseRunsOn(m[1] ?? '')
      if (!labels || labels.some((l) => l.includes('${{'))) {
        out.push(
          finding(
            'runner-labels',
            p,
            `cannot read runs-on (${m[1] || 'block form'}): use a scalar or a flow list`,
            line,
          ),
        )
      } else if (labels.includes('self-hosted') || labels.some((l) => l.startsWith('cheese-'))) {
        const exact = labels.length === C00_RUNNER.length && C00_RUNNER.every((l) => labels.includes(l))
        const known = labels.includes('self-hosted') && labels.some((l) => KNOWN_SELF_HOSTED.includes(l))
        if (c00Only ? !exact : !known) {
          const want = c00Only
            ? `[${C00_RUNNER.join(', ')}]`
            : `self-hosted with one of ${KNOWN_SELF_HOSTED.join(', ')}`
          out.push(finding('runner-labels', p, `runs-on [${labels.join(', ')}] must be ${want}`, line))
        }
      } else if (c00Only && !labels.every((l) => /^ubuntu-/.test(l))) {
        out.push(
          finding(
            'runner-labels',
            p,
            `runs-on [${labels.join(', ')}] is neither hosted ubuntu nor the C00 runner`,
            line,
          ),
        )
      }
    }
  }
  return out
}

const PATH_RE = /(?<![\w./$}{-])\/(?:var|home|etc|opt|srv|run|mnt|root)\/[A-Za-z0-9_./-]*[A-Za-z0-9_]/g
const underEntry = (path, entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`)

export function checkC00Paths(files) {
  const raw = files[PATHS_LIST]
  if (raw === undefined || raw === '')
    return [finding('c00-paths', PATHS_LIST, 'the C00 path list is missing or empty')]
  const out = []
  const entries = []
  String(raw)
    .split('\n')
    .forEach((l, i) => {
      const entry = l.trim()
      if (!entry || entry.startsWith('#')) return
      const ok =
        !entry.split('/').includes('..') &&
        ALLOWED_PATH_PREFIXES.some((pre) => (pre.endsWith('/') ? entry.startsWith(pre) : underEntry(entry, pre)))
      if (ok) entries.push(entry)
      else
        out.push(
          finding(
            'c00-paths',
            PATHS_LIST,
            `${entry} is not under an allowed prefix (${ALLOWED_PATH_PREFIXES.join(', ')})`,
            i + 1,
          ),
        )
    })
  const scanned = [...SCRIPT_FILES, ...workflows(files)]
  for (const p of scanned) {
    if (files[p] === undefined) continue
    const text = stripComments(files[p])
    const reported = new Set()
    for (const m of text.matchAll(PATH_RE)) {
      if (reported.has(m[0]) || entries.some((e) => underEntry(m[0], e))) continue
      reported.add(m[0])
      out.push(finding('c00-paths', p, `${m[0]} is used but not in ${PATHS_LIST}`, lineOf(text, m.index)))
    }
  }
  return out
}

const minutesOfDay = (h, m) => h * 60 + m

function parseCronField(field, max) {
  if (!/^\d+(,\d+)*$/.test(field)) return null
  const values = field.split(',').map(Number)
  return values.every((v) => v <= max) ? values : null
}

export function checkCronSlots(files) {
  const rule = (file, message, line) => finding('cron-slots', file, message, line)
  const yml = stripComments(files[DEPLOY_YML])
  const crons = [...yml.matchAll(/^\s*-?\s*cron:\s*(['"]?)([^'"\n]+)\1\s*$/gm)]
  if (crons.length !== 1) return [rule(DEPLOY_YML, `expected exactly one cron entry, found ${crons.length}`)]
  const cron = crons[0]
  const line = lineOf(yml, cron.index)
  const f = (cron[2] ?? '').trim().split(/\s+/)
  const mins = f.length === 5 && f.slice(2).every((x) => x === '*') ? parseCronField(f[0], 59) : null
  const hours = mins ? parseCronField(f[1], 23) : null
  if (!mins || !hours)
    return [rule(DEPLOY_YML, `cron '${cron[2]}' must be "<minutes> <hours> * * *" with plain number lists`, line)]
  const fromCron = hours.flatMap((h) => mins.map((m) => minutesOfDay(h, m)))

  const src = stripComments(files[WATCH])
  const decl = /\bconst\s+SLOT_MINUTES\s*=\s*\[([^\]]*)\]/.exec(src)
  if (!decl) return [rule(WATCH, 'cannot find `const SLOT_MINUTES = [...]`')]
  const fromWatch = []
  for (const item of (decl[1] ?? '').split(',').filter((s) => s.trim())) {
    const parts = /^\s*(\d+)\s*\*\s*60\s*\+\s*(\d+)\s*$/.exec(item)
    const plain = /^\s*(\d+)\s*$/.exec(item)
    if (parts) fromWatch.push(minutesOfDay(Number(parts[1]), Number(parts[2])))
    else if (plain) fromWatch.push(Number(plain[1]))
    else
      return [
        rule(
          WATCH,
          `cannot read SLOT_MINUTES item '${item.trim()}': use H * 60 + M or a number`,
          lineOf(src, decl.index),
        ),
      ]
  }
  const a = [...new Set(fromCron)].sort((x, y) => x - y)
  const b = [...new Set(fromWatch)].sort((x, y) => x - y)
  if (a.join() === b.join()) return []
  const show = (xs) =>
    xs.map((x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`).join(' ')
  return [
    rule(
      DEPLOY_YML,
      `cron slots (UTC ${show(a)}) differ from SLOT_MINUTES in ${WATCH} (${show(b)}): change both together`,
      line,
    ),
  ]
}

// `exec(cmd, args)` returns `{ status, stdout, stderr, error }` like spawnSync, so a test can stand in.
export function runActionlint(paths, exec, bin = process.env.ACTIONLINT || 'actionlint') {
  const res = exec(bin, ['-oneline', '-no-color', '-config-file', ACTIONLINT_CONFIG, ...paths])
  if (res.error) {
    const why =
      res.error.code === 'ENOENT'
        ? `${bin} not found: install actionlint or set ACTIONLINT`
        : String(res.error.message ?? res.error)
    return [finding('actionlint', paths[0] ?? WORKFLOW_DIR, why)]
  }
  const out = []
  for (const l of String(res.stdout ?? '').split('\n')) {
    const m = /^(.+?):(\d+):\d+: (.*)$/.exec(l)
    if (m) out.push(finding('actionlint', m[1], m[3], Number(m[2])))
  }
  if (res.status !== 0 && !out.length) {
    out.push(
      finding(
        'actionlint',
        paths[0] ?? WORKFLOW_DIR,
        `actionlint exited ${res.status}: ${String(res.stderr || res.stdout || '').trim()}`,
      ),
    )
  }
  return out
}

// The head's `c00-paths.list` read as data: every entry absolute, free of `..`, and under an allowed prefix. A
// problem is a plain string. The live preflight runs this on C00 (`c00.sh preflight`), so the prefixes are not
// repeated there.
export function pathListProblems(text) {
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    const entry = raw.trim()
    if (!entry || entry.startsWith('#')) continue
    if (!entry.startsWith('/') || entry.split('/').includes('..') || /[\s*?[\]{}$`;|&<>\\]/.test(entry))
      out.push(`${entry}: not a plain absolute path`)
    else if (!ALLOWED_PATH_PREFIXES.some((a) => underEntry(entry, a)))
      out.push(`${entry}: not under an allowed prefix (${ALLOWED_PATH_PREFIXES.join(', ')})`)
  }
  return out
}

export function runPreflight(files) {
  return [
    checkNoAppToken,
    checkTokenInput,
    checkEnvironments,
    checkVars,
    checkMergers,
    checkRunnerLabels,
    checkC00Paths,
    checkCronSlots,
  ].flatMap((rule) => rule(files))
}

export function collect(root = '.') {
  const read = (p) => (existsSync(`${root}/${p}`) ? readFileSync(`${root}/${p}`, 'utf8') : undefined)
  const files = {}
  const wfDir = `${root}/${WORKFLOW_DIR}`
  const names = existsSync(wfDir) ? readdirSync(wfDir).filter((n) => /^cd-.*\.ya?ml$/.test(n)) : []
  for (const n of names) files[`${WORKFLOW_DIR}/${n}`] = read(`${WORKFLOW_DIR}/${n}`)
  for (const p of [...SCRIPT_FILES, README, PATHS_LIST]) {
    const text = read(p)
    if (text !== undefined) files[p] = text
  }
  return files
}

// The same file set read from a git revision, never from the working tree: the live preflight checks a PR head
// whose objects were fetched but not checked out. `git(args)` returns stdout, or undefined when it fails.
export function collectFromGit(ref, git) {
  const files = {}
  const names = (git(['ls-tree', '--name-only', ref, `${WORKFLOW_DIR}/`]) ?? '').split('\n')
  for (const n of names.filter((n) => /^\.github\/workflows\/cd-[^/]*\.ya?ml$/.test(n)))
    files[n] = git(['show', `${ref}:${n}`])
  for (const p of [...SCRIPT_FILES, README, PATHS_LIST]) {
    const text = git(['show', `${ref}:${p}`])
    if (text !== undefined) files[p] = text
  }
  return files
}

export function main(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--ref')
  const ref = at >= 0 ? argv[at + 1] : undefined
  if (at >= 0 && !ref) {
    console.log('cd-preflight: --ref needs a revision')
    return 1
  }
  const git = (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return r.status === 0 ? r.stdout : undefined
  }
  const files = ref ? collectFromGit(ref, git) : collect('.')
  const spawn = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })
  let lint
  if (ref) {
    // actionlint reads files, so the head's workflows are copied out of git; names are mapped back for the report.
    const dir = mkdtempSync(join(tmpdir(), 'cd-preflight-'))
    try {
      const copies = new Map()
      for (const p of workflows(files)) {
        mkdirSync(join(dir, WORKFLOW_DIR), { recursive: true })
        const copy = join(dir, WORKFLOW_DIR, basename(p))
        writeFileSync(copy, files[p])
        copies.set(copy, p)
      }
      lint = runActionlint([...copies.keys()], spawn).map((f) => ({ ...f, file: copies.get(f.file) ?? f.file }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } else lint = runActionlint(workflows(files), spawn)
  const findings = [...lint, ...runPreflight(files)]
  for (const f of findings) console.log(formatFinding(f))
  console.log(findings.length ? `cd-preflight: ${findings.length} finding(s)` : 'cd-preflight: ok')
  return findings.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())
