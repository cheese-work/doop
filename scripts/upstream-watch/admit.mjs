#!/usr/bin/env node
// Upstream-watch admission executor (CHE-7207 plan r9, step S1c).
//   node scripts/upstream-watch/admit.mjs [--dry-run] --ledger <id> [--s9 <id>]
// The only writer that creates, cancels, retargets or promotes a sync child. It gathers the
// inputs (git ls-remote, gh api compare, multica issue children), runs decide.mjs, executes the
// actions in crash-safe order, then repairs `seen_tags` and the S9 hand-off. Every crash point
// leaves a ledger child that the next run finds and finishes.
//
// Environment: MULTICA_CLI_PATH (required), GH_BIN (gh), GIT_BIN (git), UPSTREAM_REPO_URL
// (the upstream clone URL), ADMIT_NOW (an ISO time; tests only).
// Output: one JSON report on stdout. Exit 0 = clean, 1 = an alert or a failed write, 2 = usage.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decide, parseChild } from './decide.mjs'

const UPSTREAM_URL = process.env.UPSTREAM_REPO_URL ?? 'https://github.com/kgoedecke/doop.git'
const UPSTREAM_REPO = 'kgoedecke/doop'
const FORK_REPO = 'cheese-work/doop'
const PROJECT = 'a8809cf1-12d8-4e75-82ce-f398d6004e24'
const SQUAD = 'a1073a68-4965-44ff-a8fb-244341935110' // dev team squad
const S9_AGENT = 'b47e8ae5-be3e-4abb-a91f-b4ac1e414b8c'
const BASELINE = '0.15.0' // seen_tags and the S9 hand-off cover tags after this one
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/

const semver = (v) => v.split('.').map(Number)
const cmp = (a, b) => {
  const [x, y] = [semver(a), semver(b)]
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const now = () => process.env.ADMIT_NOW ?? new Date().toISOString()

/* ---- process boundaries ---- */
const run = (bin, args, what) => {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    const e = new Error(`${what} failed: ${(r.error?.message ?? r.stderr ?? '').trim() || `exit ${r.status}`}`)
    e.stderr = r.stderr ?? ''
    throw e
  }
  return r.stdout
}
const multica = (args) => {
  const bin = process.env.MULTICA_CLI_PATH
  if (!bin) throw new Error('MULTICA_CLI_PATH is not set')
  const out = run(bin, [...args, '--output', 'json'], `multica ${args.slice(0, 3).join(' ')}`).trim()
  return out ? JSON.parse(out) : null
}
const gh = (args) => run(process.env.GH_BIN ?? 'gh', ['api', ...args], `gh api ${args[0]}`)

/* ---- gather ---- */
const flatten = (children) => (children?.stages ?? []).flatMap((s) => s.issues ?? [])

/** Stable tags of the upstream, as { version: commit }; an annotated tag's commit is the peeled one. */
function stableTags() {
  const out = run(process.env.GIT_BIN ?? 'git', ['ls-remote', '--tags', UPSTREAM_URL], 'git ls-remote')
  const tags = new Map()
  const peeled = new Map()
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    const name = ref?.replace(/^refs\/tags\//, '')
    if (!name) continue
    const isPeeled = name.endsWith('^{}')
    const m = STABLE_TAG.exec(isPeeled ? name.slice(0, -3) : name)
    if (m) (isPeeled ? peeled : tags).set(m[1], sha)
  }
  for (const [v, sha] of peeled) tags.set(v, sha)
  return tags
}

/** Is commit C an ancestor of cheese/main? 404 = the fork has never seen it, so no. */
function inMain(commit) {
  try {
    const { status } = JSON.parse(gh([`repos/${FORK_REPO}/compare/${commit}...cheese/main`]))
    return status === 'ahead' || status === 'identical'
  } catch (e) {
    if (/404|Not Found/.test(`${e.stderr ?? ''}${e.message}`)) return false
    throw e
  }
}

/** { tag: published_at }; a failure here costs only published_at in seen_tags. */
function publishedAt() {
  try {
    const list = JSON.parse(gh([`repos/${UPSTREAM_REPO}/releases?per_page=100`]))
    return { map: Object.fromEntries(list.filter((r) => !r.draft).map((r) => [r.tag_name, r.published_at ?? null])) }
  } catch (e) {
    return { map: {}, warning: e.message }
  }
}

/* ---- the child text ---- */
export const childDescription = ({ version, commit, waitsFor }) =>
  [
    `Upstream: ${UPSTREAM_REPO} v${version} commit ${commit}`,
    '',
    ...(waitsFor ? [`Waits for: ${waitsFor}`, ''] : []),
    `Merge upstream doop ${version} into \`cheese/main\`. Every sync PR has base \`cheese/main\` and is never retargeted.`,
    '',
    'Fetch the tag and stop on a commit mismatch:',
    '```',
    `git fetch https://github.com/${UPSTREAM_REPO}.git "refs/tags/v${version}:refs/tags/v${version}"`,
    `test "$(git rev-parse 'v${version}^{commit}')" = "${commit}"   # stop on mismatch`,
    '```',
    '',
  ].join('\n')
export const childTitle = (version) => `task(doop): merge upstream doop ${version} into cheese/main`

/* ---- execute ---- */
function withDescriptionFile(text, fn) {
  // the CLI reads description files only from inside the working directory
  const dir = mkdtempSync(join(process.cwd(), '.admit-'))
  try {
    const file = join(dir, 'description.md')
    writeFileSync(file, text)
    return fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CONFLICT = /conflict|revision|409/i

function promote(a, report) {
  try {
    multica(['issue', 'update', a.id, '--status', 'todo', '--expected-revision', String(a.revision)])
    return { ...a, result: 'promoted' }
  } catch (e) {
    if (!CONFLICT.test(e.message)) throw e
    // one re-read, never a second write: a loser of the compare-and-set finds the work started
    const now = multica(['issue', 'get', a.key])
    if (now.status === 'backlog')
      report.alerts.push({
        code: 'promote-conflict',
        key: a.key,
        detail: `revision moved to ${now.revision}; left for the next run`,
      })
    return { ...a, result: now.status === 'backlog' ? 'conflict' : `already-${now.status}` }
  }
}

function cancelDuplicate(a) {
  try {
    multica(['issue', 'status', a.id, 'cancelled', '--duplicate-of', a.duplicateOf])
  } catch (e) {
    // a concurrent run may have cancelled it first
    if (multica(['issue', 'get', a.key]).status !== 'cancelled') throw e
  }
  return { ...a, result: 'cancelled' }
}

function create(a, ledger) {
  return withDescriptionFile(childDescription(a), (file) => {
    const issue = multica([
      'issue',
      'create',
      '--title',
      childTitle(a.version),
      '--description-file',
      file,
      '--parent',
      ledger.id,
      '--status',
      'backlog',
      '--project',
      PROJECT,
      '--assignee-id',
      SQUAD,
      '--priority',
      'high',
      '--property',
      'Readiness=ready',
    ])
    return { ...a, result: 'created', key: issue?.identifier }
  })
}

function retarget(a) {
  // decide.mjs does not carry a revision on retarget: read it now, write against it
  const revision = multica(['issue', 'get', a.key]).revision
  return withDescriptionFile(childDescription(a), (file) => {
    multica([
      'issue',
      'update',
      a.id,
      '--title',
      childTitle(a.version),
      '--description-file',
      file,
      '--expected-revision',
      String(revision),
      '--no-start',
    ])
    return { ...a, result: 'retargeted' }
  })
}

function execute(actions, ctx, report) {
  for (const a of actions) {
    if (a.type === 'cancel_duplicate') report.executed.push(cancelDuplicate(a))
    else if (a.type === 'promote') report.executed.push(promote(a, report))
    else if (a.type === 'retarget') report.executed.push(retarget(a))
    else if (a.type === 'create') {
      report.executed.push(create(a, ctx.ledger))
      if (!a.promote) continue
      // list again, dedupe, promote the survivor; a concurrent run's child is found here
      const again = decide({ ...ctx.input, children: listChildren(ctx.ledger.id) })
      report.alerts.push(...again.alerts)
      execute(
        again.actions.filter((x) => x.type === 'cancel_duplicate' || x.type === 'promote'),
        ctx,
        report,
      )
    }
  }
}

const listChildren = (ledgerId) => flatten(multica(['issue', 'children', ledgerId]))

/* ---- repairs ---- */
function seenTagsRepair(ledger, tags, dryRun) {
  const raw = ledger.metadata?.seen_tags
  const old = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
  const rel = publishedAt()
  const next = { ...old }
  for (const [version, commit] of tags) {
    if (cmp(version, BASELINE) <= 0) continue
    const tag = `v${version}`
    const had = old[tag]
    next[tag] = {
      commit: had?.commit ?? commit,
      published_at: had?.published_at ?? rel.map[tag] ?? null,
      seen_at: had?.seen_at ?? now(),
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(old)
  if (changed && !dryRun)
    multica(['issue', 'metadata', 'set', ledger.id, '--key', 'seen_tags', '--value', JSON.stringify(next)])
  return { changed, written: changed && !dryRun, ...(rel.warning ? { warning: rel.warning } : {}) }
}

function handoffRepair(s9Id, ledgerId, dryRun) {
  if (!s9Id) return { skipped: 'no S9 issue given' }
  const s9 = multica(['issue', 'get', s9Id])
  if (['done', 'cancelled'].includes(s9.status)) return { skipped: `S9 is ${s9.status}` }
  if (s9.metadata?.measure_sync_issue) return { skipped: 'measure_sync_issue is set' }
  const first = listChildren(ledgerId)
    .map(parseChild)
    .filter((p) => p && cmp(p.version, BASELINE) > 0)
    .sort((a, b) => a.number - b.number)[0]
  if (!first) return { skipped: 'no ledger child after v0.15.0' }
  if (dryRun) return { planned: { wakeup: s9Id, until_issue: first.key } }
  // a crash between the wakeup and the key must not leave two wakeups
  const existing = JSON.stringify(multica(['issue', 'wakeup', 'list', s9Id]) ?? [])
  const hadWakeup = existing.includes(first.id)
  if (!hadWakeup)
    multica([
      'issue',
      'wakeup',
      'create',
      s9Id,
      '--until-issue',
      first.id,
      '--until-issue-state',
      'ended',
      '--expires-in',
      '504h',
      '--on-timeout',
      'wake',
      '--agent-id',
      S9_AGENT,
      '--instruction',
      `The first ledger child after v0.15.0 (${first.key}) ended or 21 days passed: run the S9 measurement.`,
    ])
  multica(['issue', 'metadata', 'set', s9Id, '--key', 'measure_sync_issue', '--value', first.key, '--type', 'string'])
  return { written: true, child: first.key, wakeup: hadWakeup ? 'already-existed' : 'created' }
}

/* ---- main ---- */
export function main(argv) {
  const dryRun = argv.includes('--dry-run')
  const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined)
  const ledgerId = flag('--ledger')
  if (!ledgerId) {
    process.stderr.write('usage: admit.mjs [--dry-run] --ledger <id> [--s9 <id>]\n')
    return 2
  }
  const report = { dryRun, ledger: [], alerts: [], actions: [], executed: [], repairs: {} }
  try {
    const ledger = multica(['issue', 'get', ledgerId])
    const children = listChildren(ledger.id)
    report.ledger = children
      .map(parseChild)
      .filter(Boolean)
      .map((p) => ({
        key: p.key,
        version: p.version,
        commit: p.commit,
        status: p.status,
        claimed: p.claimed,
        live: p.live,
      }))

    let tags = new Map()
    let input
    try {
      tags = stableTags()
      const newest = [...tags.keys()].sort(cmp).at(-1)
      if (!newest) throw new Error('no stable tag in the upstream')
      const commit = tags.get(newest)
      report.tag = `v${newest}`
      report.commit = commit
      input = { tag: `v${newest}`, commit, inMain: inMain(commit), children, lookupError: null }
    } catch (e) {
      input = { tag: '', commit: '', inMain: false, children, lookupError: e.message }
    }
    report.inMain = input.inMain

    const decided = decide(input)
    report.alerts.push(...decided.alerts)
    report.actions = decided.actions
    // lookup error or an unparseable child: zero writes of any kind
    const closed = decided.alerts.some((a) => a.code === 'lookup-error' || a.code === 'unparseable')
    const s9 = flag('--s9') ?? ledger.metadata?.s9_issue

    if (dryRun) {
      if (!closed) {
        report.repairs.seen_tags = seenTagsRepair(ledger, tags, true)
        report.repairs.s9_handoff = handoffRepair(s9, ledger.id, true)
      }
    } else if (!closed) {
      execute(decided.actions, { ledger, input }, report)
      report.repairs.seen_tags = seenTagsRepair(ledger, tags, false)
      report.repairs.s9_handoff = handoffRepair(s9, ledger.id, false)
    }
  } catch (e) {
    report.error = e.message
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  return report.error || report.alerts.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2))
