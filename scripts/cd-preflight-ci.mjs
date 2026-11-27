#!/usr/bin/env node
// The live CD preflight (CHE-9957, CHE-9850 S6): the steps of `.github/workflows/cd-preflight.yml`.
//
//   scope    which files the PR touches, and whether the C00 runner is asked at all
//   github   the static preflight (scripts/cd-preflight.mjs) over the head's files, the live environment and variable
//            names, and the `github.token` quota
//   report   the one result: scope + github, and the C00 job read with its own clock (never `needs: c00`)
//   path-list <file>, marker   the two checks `c00.sh preflight` runs through node on the C00 host
//
// SECURITY: this file runs from the BASE revision. The PR head is data: `git show <sha>:<path>` and the PR file list.
// Nothing here executes, imports or evaluates a head file, and nothing prints a secret.
//
// The report never waits on the C00 runner. A job on a dead self-hosted runner stays `queued` for a day, so a
// `needs: c00` report would hang; `waitForC00` polls the job's status and gives up after 10 minutes (FP-01).
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  collectFromGit,
  environmentRefs,
  formatFinding,
  pathListProblems,
  readmeRows,
  varRefs,
} from './cd-preflight.mjs'
import { kindOf, markerFile } from './deploy-marker.mjs'

const MIN = 60_000
export const OFFLINE_AFTER_MS = 10 * MIN
// After the runner took the job: c00 has a 5 minute timeout, so this leaves room inside the report's 12.
export const REPORT_DEADLINE_MS = 11 * MIN
export const POLL_MS = 15_000
export const QUOTA_WARN_BELOW = 0.2
const NOT_STARTED = new Set(['queued', 'waiting', 'pending', 'requested'])
const README = 'deploy/cd/README.md'

// The files whose change the CD preflight cares about. Anything else reports success "n/a".
const CD_PATTERNS = [
  /^\.github\/workflows\/(cd-[^/]+|image)\.ya?ml$/,
  /^\.github\/actionlint\.ya?ml$/,
  /^deploy\/cd\//,
  /^scripts\/(cd-[^/]+|deploy-[^/]+|gh-rate-limit|image-evidence|migration-inventory)\.mjs$/,
]
export const isCdPath = (path) => CD_PATTERNS.some((re) => re.test(String(path)))
export const touchesCd = (paths) => paths.some(isCdPath)

/** Only a head in this repository may reach the C00 runner. A fork head never runs on it. */
export const sameRepo = (headRepo, repo) =>
  Boolean(headRepo) && String(headRepo).toLowerCase() === String(repo).toLowerCase()

/** `{ limit, remaining }` from `GET /rate_limit` (`resources.core`), or null when it could not be read. */
export function quotaStatus(core) {
  if (!core || !Number.isFinite(core.limit) || !Number.isFinite(core.remaining) || core.limit <= 0)
    return { warn: true, message: 'github.token quota unreadable' }
  const pct = Math.round((core.remaining / core.limit) * 100)
  const warn = core.remaining / core.limit < QUOTA_WARN_BELOW
  return {
    warn,
    message: `github.token quota: ${core.remaining} of ${core.limit} left (${pct}%)${warn ? ', below 20%' : ''}`,
  }
}

/**
 * The environments and variables the workflows name must exist in the repository. `live` is
 * `{ environments, variables }`, each a list of names or null when GitHub would not say (the caller warns: an unreadable
 * list never fails here and never counts as found). Only a variable the README marks `required` and the workflow reads
 * without a `||` fallback must exist: an unset `MAIN_RED_PAUSED` is a normal state.
 */
export function checkLiveNames(files, live, readme = '') {
  const out = []
  if (live.environments) {
    const have = new Set(live.environments)
    const seen = new Set()
    for (const r of environmentRefs(files)) {
      if (!r.value || have.has(r.value) || seen.has(r.value)) continue
      seen.add(r.value)
      out.push({
        rule: 'live-environment',
        file: r.file,
        line: r.line,
        message: `environment ${r.value} does not exist in the repository`,
      })
    }
  }
  if (live.variables) {
    const have = new Set(live.variables.map((v) => v.toUpperCase()))
    const required = new Set(
      readmeRows(readme)
        .filter((r) => /\bvar(iable)?\b/.test(r.kind) && /\brequired\b/i.test(r.text))
        .map((r) => r.name.toUpperCase()),
    )
    const seen = new Set()
    for (const r of varRefs(files)) {
      const name = r.name.toUpperCase()
      if (have.has(name) || r.fallback || !required.has(name) || seen.has(name)) continue
      seen.add(name)
      out.push({ rule: 'live-vars', file: r.file, line: r.line, message: `repository variable ${r.name} is not set` })
    }
  }
  return out
}

/**
 * Wait for the `c00` job without ever waiting on a runner that is not there.
 * `observe()` returns `{ status, conclusion }` for the job, or null when the job is not listed; it may throw (an
 * unreadable list is retried). Not started (queued, waiting, absent) for `offlineAfterMs` is "C00 runner offline".
 * The conclusion is read only once the status is `completed`. `now` and `sleep` are injected, so a test runs 10
 * minutes in no time.
 */
export async function waitForC00({
  observe,
  now,
  sleep,
  offlineAfterMs = OFFLINE_AFTER_MS,
  deadlineMs = REPORT_DEADLINE_MS,
  pollMs = POLL_MS,
}) {
  const t0 = now()
  let started = false
  let lastError = ''
  for (;;) {
    let obs = null
    try {
      obs = await observe()
      lastError = ''
    } catch (err) {
      lastError = String(err?.message ?? err)
    }
    const status = obs?.status
    if (status === 'completed') {
      const conclusion = obs.conclusion
      if (conclusion === 'success' || conclusion === 'skipped') return { ok: true, message: `c00 job ${conclusion}` }
      return { ok: false, message: `c00 job ended ${conclusion ?? 'without a conclusion'}` }
    }
    if (status && !NOT_STARTED.has(status)) started = true
    const waited = now() - t0
    if (!started && waited >= offlineAfterMs) {
      const why = lastError ? ` (job list unreadable: ${lastError})` : ''
      return {
        ok: false,
        message: `C00 runner offline: the c00 job did not start in ${offlineAfterMs / MIN} minutes${why}`,
      }
    }
    if (waited >= deadlineMs) return { ok: false, message: `c00 job did not finish within ${deadlineMs / MIN} minutes` }
    await sleep(pollMs)
  }
}

/**
 * The one result. `scope` and `github` are job results (`success`, `failure`, `skipped`, `cancelled`); `cd` is the
 * scope's answer ('true'/'false'); `c00` is `{ ok, message }` from waitForC00, or null when the runner was not asked.
 */
export function decideReport({ scope, github, cd, c00 }) {
  const lines = []
  if (scope !== 'success') return { ok: false, lines: [`scope: ${scope || 'no result'}`] }
  if (cd !== 'true') return { ok: true, lines: ['n/a: the PR touches no CD path'] }
  let ok = true
  if (github === 'success') lines.push('github: ok')
  else {
    ok = false
    lines.push(`github: ${github || 'no result'}`)
  }
  if (!c00) lines.push('c00: not asked (a fork head never reaches the C00 runner)')
  else {
    if (!c00.ok) ok = false
    lines.push(`c00: ${c00.message}`)
  }
  return { ok, lines }
}

// ---- command line --------------------------------------------------------------------------------------------

/** Head text printed to the log: a `::command::` at a line start would run as a workflow command, so none survives. */
export const safeLog = (text) => String(text).replace(/\r/g, '').replace(/::/g, ': :')

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const out = (name, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  console.log(`${name}=${value}`)
}
const summary = (lines) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}
/** `gh api <path>` parsed as JSON, or null when it fails (the caller decides what an unreadable answer means). */
function ghJson(path, extra = []) {
  const r = run('gh', ['api', path, ...extra])
  if (r.status !== 0) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

function scope(env) {
  const event = env.EVENT_NAME
  let cd = true
  let same = true
  if (event === 'pull_request_target') {
    const files = []
    for (let page = 1; ; page++) {
      const r = ghJson(`repos/${env.REPO}/pulls/${env.PR_NUMBER}/files?per_page=100&page=${page}`)
      if (!r) {
        console.log('scope: the PR file list is unreadable')
        return 1
      }
      for (const f of r) files.push(f.filename, f.previous_filename)
      if (r.length < 100) break
    }
    cd = touchesCd(files.filter(Boolean))
    same = sameRepo(env.HEAD_REPO, env.REPO)
  }
  out('cd', String(cd))
  out('same_repo', String(same))
  out('c00_expected', String(cd && same))
  return 0
}

function github(env) {
  const ref = env.HEAD_SHA || 'HEAD'
  const git = (args) => {
    const r = run('git', args)
    return r.status === 0 ? r.stdout : undefined
  }
  const files = collectFromGit(ref, git)
  const findings = []
  const lint = run(process.execPath, ['scripts/cd-preflight.mjs', '--ref', ref])
  const lintLines = String(lint.stdout ?? '')
    .split('\n')
    .filter((l) => l && !l.startsWith('cd-preflight: ok') && !/^cd-preflight: \d+ finding/.test(l))
  if (lint.status !== 0 && !lintLines.length)
    lintLines.push(`cd-preflight exited ${lint.status}: ${String(lint.stderr ?? '').trim()}`)
  const lines = [...lintLines]

  const envs = ghJson(`repos/${env.REPO}/environments?per_page=100`)
  const variables = env.VARS_JSON ? Object.keys(JSON.parse(env.VARS_JSON)) : null
  const live = { environments: envs ? envs.environments.map((e) => e.name) : null, variables }
  for (const f of checkLiveNames(files, live, files[README] ?? '')) lines.push(formatFinding(f))
  for (const [what, v] of [
    ['environments', live.environments],
    ['variables', live.variables],
  ])
    if (!v) console.log(`::warning::${what} could not be listed, so their names were not checked`)

  const quota = quotaStatus(ghJson('rate_limit')?.resources?.core)
  console.log(`${quota.warn ? '::warning::' : ''}${quota.message}`)
  summary([`### CD preflight: github`, quota.message, ...lines.map((l) => `- ${l}`)])
  for (const l of lines) console.log(safeLog(l))
  findings.push(...lines)
  console.log(findings.length ? `github: ${findings.length} finding(s)` : 'github: ok')
  return findings.length ? 1 : 0
}

async function report(env) {
  let c00 = null
  if (env.C00_EXPECTED === 'true') {
    const observe = async () => {
      const r = run('gh', [
        'api',
        '--paginate',
        `repos/${env.REPO}/actions/runs/${env.RUN_ID}/jobs?per_page=100`,
        '--jq',
        '.jobs[] | {name, status, conclusion}',
      ])
      if (r.status !== 0) throw new Error(`gh api exited ${r.status}`)
      const jobs = String(r.stdout)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      return jobs.find((j) => j.name === 'c00') ?? null
    }
    c00 = await waitForC00({ observe, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
  }
  const result = decideReport({ scope: env.SCOPE_RESULT, github: env.GH_RESULT, cd: env.CD, c00 })
  const lines = [`cd-preflight: ${result.ok ? 'pass' : 'FAIL'}`, ...result.lines]
  for (const l of lines) console.log(l)
  if (!result.ok) console.log(`::error::${result.lines.join('; ')}`)
  summary(['### CD preflight', ...lines.map((l) => `- ${l}`)])
  return result.ok ? 0 : 1
}

function pathList(file) {
  const problems = pathListProblems(readFileSync(file, 'utf8'))
  for (const p of problems) console.log(safeLog(`path list: ${p}`))
  return problems.length ? 1 : 0
}

function marker(env) {
  const file = markerFile(env)
  let value
  try {
    value = readFileSync(file, 'utf8').replace(/\n$/, '')
  } catch (err) {
    console.log(`marker: cannot read ${file}: ${err?.code ?? err}`)
    return 1
  }
  const kind = kindOf(value)
  if (!kind) {
    console.log(`marker: ${file} holds no valid state word`)
    return 1
  }
  console.log(`marker: ${kind}`)
  return 0
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  switch (argv[0]) {
    case 'scope':
      return scope(env)
    case 'github':
      return github(env)
    case 'report':
      return report(env)
    case 'path-list':
      return pathList(argv[1] ?? '')
    case 'marker':
      return marker(env)
    default:
      console.log('usage: cd-preflight-ci.mjs scope | github | report | path-list <file> | marker')
      return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main())
