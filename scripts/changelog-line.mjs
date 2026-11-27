#!/usr/bin/env node
// Changelog line guard (CHE-10491, CHE-10416 S1). A feat/fix/perf PR to cheese/main must carry a valid
// `Changelog(feat|fix|perf): <sentence>` line, so the /changelog page has one line per fork PR.
// The line grammar is ported from the Multica fork's scripts/fork-changelog.mjs (CHE-1631 contract):
// 140 code points, invisible characters stripped, credential and issue-id probe.
// Pure functions plus one CLI, Node standard library only (CI runs it from the PR base SHA, so it must
// not import anything from the checkout):
//   node changelog-line.mjs --pr <json> --files <file>
//     <json>  { title, body, baseRef }       <file>  one changed path per line
// Prints one result line (also to $GITHUB_STEP_SUMMARY) and exits 1 when the PR fails.
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const BASE_BRANCH = 'cheese/main'
const SYNC_TITLE = /merge upstream doop/i
const MAX_CODE_POINTS = 140
const REQUIRES_LINE = new Set(['feat', 'fix', 'perf'])
const RERUN_NOTE = 'Edit the PR body, then push a new commit or re-run this job: the check reads the body when it runs.'

// Paths a user can see in a build. `Changelog: none` is refused when a PR touches one of these.
const USER_FACING = [
  'src/',
  'server/',
  'shared/',
  'public/',
  'desktop/',
  'android/',
  'ios/',
  'chrome-extension/',
  'claude-extension/',
  'chatgpt-plugin/',
  'cursor-plugin/',
]
export const isUserFacingPath = (path) => USER_FACING.some((prefix) => path.startsWith(prefix))

const LINE = /^Changelog(?:\((feat|fix|perf)\))?:\s?([^\n]*)$/

// Everything invisible is stripped by Unicode property, not by list: default-ignorable
// (zero-width, bidi, fillers, variation selectors, tags), format, control, unassigned,
// private use, surrogates and line/paragraph separators. Valid emoji survive: a base
// keeps its skin tone, one VS16 and a joiner that leads into another pictograph; a
// keycap keeps its VS16; the three tag flags (England, Scotland, Wales) stay whole.
const INVISIBLE = '\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Cc}\\p{Cn}\\p{Co}\\p{Cs}\\p{Zl}\\p{Zp}'
const tagFlag = (code) =>
  `\u{1F3F4}${[...code].map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0))).join('')}\u{E007F}`
const TAG_FLAGS = ['gbeng', 'gbsct', 'gbwls'].map(tagFlag).join('|')
const STRIP_INVISIBLE = new RegExp(
  `(${TAG_FLAGS}|[0-9#*]\\ufe0f\\u20e3)|(\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]*)(\\ufe0f)?(\\u200d(?=\\p{Extended_Pictographic}))?|[${INVISIBLE}]`,
  'gu',
)
// Credential and issue-id probe only: NFKD folds look-alikes (full-width letters) and
// splits accented letters into base plus mark, then every mark is dropped so no mark can
// split a pattern or compose into a different letter first.
// Dash look-alikes fold to a hyphen (NFKD already folds U+2011 and U+FF0D).
const DASHES = /[‐-―−﹘﹣]/g
const PROBE_MARKS = /[\p{Cf}\p{Mn}\p{Me}]/gu
const TOKENS = [
  /ghp_[A-Za-z0-9]{10,}/,
  /github_pat_[A-Za-z0-9_]{10,}/,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,
]

// Drops HTML comments (an unclosed one runs to the end) and fenced code. A fence
// closes only on the same character, at least as long, with nothing else on the line.
function liveLines(body) {
  const text = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '')
  let fence = null
  return text.split('\n').filter((line) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
      return false
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (open) {
      fence = open[1]
      return false
    }
    return true
  })
}

function truncateGraphemes(text, limit) {
  let used = 0
  let out = ''
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
    used += [...segment].length
    if (used > limit) break
    out += segment
  }
  return out
}

const result = (status, text, override, warnings) => ({ status, text, override, warnings })

/** The first live Changelog line: status text | none | missing | parse-error. */
export function parseChangelogLine(body) {
  const matches = liveLines(typeof body === 'string' ? body : '')
    .map((line) => LINE.exec(line))
    .filter(Boolean)
  if (matches.length === 0) return result('missing', null, null, [])
  const warnings = []
  if (matches.length > 1) warnings.push('More than one Changelog line: the first one is used.')

  const [, override, raw] = matches[0]
  const spaced = raw.trim().replace(/[\t\v\f]/g, ' ')
  const stripped = spaced.replace(STRIP_INVISIBLE, (match, whole, base, selector, joiner) => {
    if (whole) return whole
    return base ? `${base}${selector ?? ''}${joiner ?? ''}` : ''
  })
  const cleaned = stripped.replace(/\s+/g, ' ').trim()
  if (stripped !== spaced) warnings.push('Stripped invisible or control characters from the sentence.')
  if (cleaned === '') return result('missing', null, null, warnings)
  if (/<[^\s<>][^<>]*>/.test(cleaned)) {
    warnings.push('The Changelog line holds a <placeholder>.')
    return result('missing', null, null, warnings)
  }
  if (cleaned.toLowerCase() === 'none') return result('none', null, null, warnings)
  const probe = cleaned.normalize('NFKD').replace(PROBE_MARKS, '').replace(DASHES, '-')
  if (TOKENS.some((token) => token.test(probe))) {
    warnings.push('The sentence looks like a credential and is hidden.')
    return result('parse-error', null, null, warnings)
  }
  if (/\bCHE-\d+\b/i.test(probe)) {
    warnings.push('The sentence names an issue id and is hidden: users cannot open it.')
    return result('parse-error', null, null, warnings)
  }

  let text = cleaned
  if ([...text].length > MAX_CODE_POINTS) {
    text = truncateGraphemes(text, MAX_CODE_POINTS).trimEnd()
    warnings.push(`Truncated to ${MAX_CODE_POINTS} characters.`)
  }
  return result('text', text, override ?? null, warnings)
}

export const titleType = (title) => /^([a-z]+)(?:\([^)]*\))?!?:/i.exec(title ?? '')?.[1].toLowerCase() ?? null

/**
 * One PR: { title, body, baseRef, files } -> one of
 *   skip   { reason: base | upstream-sync }       not checked
 *   entry  { text, warnings }                     a valid line
 *   none   { warnings }                           `Changelog: none` on internal paths only
 *   absent { reason, warnings }                   no valid line, and this PR type does not need one
 *   fail   { reason: missing | parse-error | none-on-user-facing, paths?, warnings }
 */
export function evaluatePr({ title = '', body = '', baseRef = '', files = [] }) {
  if (baseRef !== BASE_BRANCH) return { kind: 'skip', reason: 'base', warnings: [] }
  if (SYNC_TITLE.test(title)) return { kind: 'skip', reason: 'upstream-sync', warnings: [] }

  const parsed = parseChangelogLine(body)
  const { warnings } = parsed
  if (parsed.status === 'text') return { kind: 'entry', text: parsed.text, warnings }

  const required = REQUIRES_LINE.has(titleType(title))
  if (parsed.status === 'none') {
    const paths = files.filter(isUserFacingPath)
    if (required && paths.length > 0) return { kind: 'fail', reason: 'none-on-user-facing', paths, warnings }
    return { kind: 'none', warnings }
  }
  if (required) return { kind: 'fail', reason: parsed.status, warnings }
  return { kind: 'absent', reason: parsed.status, warnings }
}

const MAX_NAMED_PATHS = 3

/** { line, failing, message?, warnings } for the job log and the job summary. */
export function formatCheck(evaluation) {
  const { warnings } = evaluation
  switch (evaluation.kind) {
    case 'skip':
      return {
        line: `Skipped: ${evaluation.reason === 'base' ? `the base is not ${BASE_BRANCH}` : 'an upstream sync'}.`,
        failing: false,
        warnings,
      }
    case 'entry':
      return { line: `Entry: "${evaluation.text}"`, failing: false, warnings }
    case 'none':
      return { line: 'None: this PR publishes no changelog entry.', failing: false, warnings }
    case 'absent':
      return {
        line: `Not required: this PR type needs no Changelog line (${evaluation.reason}).`,
        failing: false,
        warnings,
      }
    default: {
      const line =
        evaluation.reason === 'none-on-user-facing'
          ? `Refused: "Changelog: none" on a PR that touches a user-facing path (${evaluation.paths.slice(0, MAX_NAMED_PATHS).join(', ')}${evaluation.paths.length > MAX_NAMED_PATHS ? ', ...' : ''}). Write one sentence for users.`
          : evaluation.reason === 'parse-error'
            ? 'Refused: the Changelog sentence holds a credential or an issue id. Write one sentence for users.'
            : 'Missing: this feat/fix/perf PR has no valid "Changelog: <sentence>" line (a <placeholder> or an empty value does not count).'
      return { line, failing: true, message: RERUN_NOTE, warnings }
    }
  }
}

function runCheck(prPath, filesPath, env) {
  const pr = JSON.parse(readFileSync(prPath, 'utf8'))
  const files = readFileSync(filesPath, 'utf8').split('\n').filter(Boolean)
  const check = formatCheck(
    evaluatePr({ title: pr.title ?? '', body: pr.body ?? '', baseRef: pr.baseRef ?? '', files }),
  )
  console.log(check.line)
  for (const message of check.warnings) console.log(`::warning::${message}`)
  if (check.failing) console.log(`::error::${check.line} ${check.message}`)
  if (env.GITHUB_STEP_SUMMARY) {
    const lines = ['### Changelog line', '', '```text', check.line.replace(/`/g, "'"), '```']
    for (const message of check.warnings) lines.push('', `- Warning: ${message}`)
    if (check.failing) lines.push('', check.message)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
  return check.failing ? 1 : 0
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`Bad argument: ${argv[i]}`)
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

export function main(argv, env) {
  try {
    const args = parseArgs(argv)
    if (!args.pr || !args.files) throw new Error('Use --pr <json> --files <file>')
    return runCheck(args.pr, args.files, env)
  } catch (error) {
    console.error(`changelog-line: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env)
}
