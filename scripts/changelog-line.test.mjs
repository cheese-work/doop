import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluatePr, formatCheck, isUserFacingPath, parseChangelogLine, titleType } from './changelog-line.mjs'

/* CHE-10491 (CHE-10416 S1). The line grammar is ported from the Multica fork's fork-changelog.test.mjs
   (CHE-1631 contract); the guard rules and the CLI are new for doop. */

const SCRIPT = new URL('./changelog-line.mjs', import.meta.url).pathname
const ROOT = new URL('../', import.meta.url)
const TOKEN = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'

const pr = (over = {}) => ({
  title: 'fix(canvas): keep the selection',
  body: 'Changelog: The selection now survives a zoom.',
  baseRef: 'cheese/main',
  files: ['src/canvas.ts'],
  ...over,
})

describe('line grammar', () => {
  it('parses the first Changelog line and keeps the sentence', () => {
    const got = parseChangelogLine('intro\n\nChangelog: Issue lists now open instantly.\nmore')
    expect(got).toMatchObject({ status: 'text', text: 'Issue lists now open instantly.', override: null })
    expect(parseChangelogLine('Changelog:No space is fine.').text).toBe('No space is fine.')
  })

  it('reads the section override and rejects look-alikes', () => {
    for (const kind of ['feat', 'fix', 'perf']) {
      expect(parseChangelogLine(`Changelog(${kind}): Something.`).override).toBe(kind)
    }
    expect(parseChangelogLine('Changelog(docs): Something.').status).toBe('missing')
    expect(parseChangelogLine('changelog: lower case is not a line').status).toBe('missing')
    expect(parseChangelogLine('  Changelog: indented is not at line start').status).toBe('missing')
    // the literal template line is not a line
    expect(parseChangelogLine('Changelog(feat|fix|perf): ').status).toBe('missing')
  })

  it('parses CRLF and lone CR like LF', () => {
    expect(parseChangelogLine('a\r\nChangelog: Works.\r\nb').text).toBe('Works.')
    expect(parseChangelogLine('a\rChangelog: Works.\rb').text).toBe('Works.')
  })

  it('uses the first match and warns on extra ones', () => {
    const got = parseChangelogLine('Changelog: First.\nChangelog: Second.')
    expect(got.text).toBe('First.')
    expect(got.warnings.join('|')).toMatch(/more than one/i)
  })

  it('ignores lines in HTML comments (closed or unclosed) and code fences', () => {
    expect(parseChangelogLine('<!--\nChangelog: Hidden.\n-->').status).toBe('missing')
    expect(parseChangelogLine('<!-- open\nChangelog: Hidden.').status).toBe('missing')
    expect(parseChangelogLine('```\nChangelog: Hidden.\n```').status).toBe('missing')
    expect(parseChangelogLine('~~~md\nChangelog: Hidden.\n~~~').status).toBe('missing')
    expect(parseChangelogLine('<!-- c -->\nChangelog: Shown.').text).toBe('Shown.')
    // a fence does not close on a different or shorter delimiter
    expect(parseChangelogLine('````\n```\nChangelog: Hidden.\n```\n````').status).toBe('missing')
    expect(parseChangelogLine('```\n~~~\nChangelog: Hidden.\n~~~\n```').status).toBe('missing')
  })

  it('treats blank values and <placeholders> as missing, none as explicit', () => {
    expect(parseChangelogLine('Changelog:').status).toBe('missing')
    expect(parseChangelogLine('Changelog:   ').status).toBe('missing')
    const placeholder = parseChangelogLine('Changelog: <one user-facing sentence, or none>')
    expect(placeholder.status).toBe('missing')
    expect(placeholder.warnings.join('|')).toMatch(/placeholder/i)
    expect(parseChangelogLine('Changelog: Fixed the <page name> layout.').status).toBe('missing')
    expect(parseChangelogLine('Changelog: Two is less than three, 2 < 3 and 4 > 3.').status).toBe('text')
    expect(parseChangelogLine('Changelog: none').status).toBe('none')
    expect(parseChangelogLine('Changelog: None').status).toBe('none')
    expect(parseChangelogLine(null).status).toBe('missing')
    expect(parseChangelogLine(undefined).status).toBe('missing')
  })
})

describe('length limit: 140 code points', () => {
  it('cuts at 140 without splitting a grapheme, and warns', () => {
    const cut = parseChangelogLine(`Changelog: ${'a'.repeat(138)}${FAMILY}`)
    expect(cut.text).toBe('a'.repeat(138))
    expect(cut.warnings.join('|')).toMatch(/truncat/i)

    const exact = parseChangelogLine(`Changelog: ${'b'.repeat(140)}`)
    expect(exact.text).toHaveLength(140)
    expect(exact.warnings.join('|')).not.toMatch(/truncat/i)

    expect([...parseChangelogLine(`Changelog: ${'\u{1F600}'.repeat(150)}`).text]).toHaveLength(140)
  })

  it('fails a feat PR whose line is too long (the check prints the cut text and a warning)', () => {
    const result = evaluatePr(pr({ title: 'feat: x', body: `Changelog: ${'c'.repeat(141)}` }))
    expect(result.kind).toBe('entry')
    expect(result.text).toHaveLength(140)
    expect(result.warnings.join('|')).toMatch(/truncat/i)
  })
})

describe('invisible characters', () => {
  it('strips control, bidi and zero-width characters with a warning', () => {
    const got = parseChangelogLine('Changelog: Fixed‮ evil⁦ text​ here\u0007﻿⁠.')
    expect(got.status).toBe('text')
    expect(got.text).toBe('Fixed evil text here.')
    expect(got.warnings.join('|')).toMatch(/strip/i)
  })

  it('keeps emoji sequences, tag flags, keycaps and accents unchanged and silent', () => {
    const tag = (word) =>
      [...word].map((ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0))).join('') + '\u{e007f}'
    const flags = ['gbeng', 'gbsct', 'gbwls'].map((code) => `\u{1f3f4}${tag(code)}`)
    const keycaps = ['1', '#', '*'].map((ch) => `${ch}️⃣`)
    const samples = [
      FAMILY,
      '\u{1F469}\u{1F3FD}‍\u{1F4BB}',
      '❤️‍\u{1F525}',
      '\u{1F44D}\u{1F3FB}',
      'café é',
      ...flags,
      ...keycaps,
    ]
    for (const sample of samples) {
      const got = parseChangelogLine(`Changelog: Keeps ${sample} intact.`)
      expect(got.text, JSON.stringify(sample)).toBe(`Keeps ${sample} intact.`)
      expect(got.warnings.join('|'), JSON.stringify(sample)).not.toMatch(/strip/i)
    }
  })

  it('strips a joiner that has no emoji base, and tag characters outside a recognized flag', () => {
    for (const lead of ['A️', '\u{1F3FB}', '️', 'A']) {
      const got = parseChangelogLine(`Changelog: Odd ${lead}‍\u{1F600} sequence.`)
      expect(got.text, JSON.stringify(lead)).not.toMatch(/‍/)
      expect(got.warnings.join('|')).toMatch(/strip/i)
    }
    const smuggled = [...'hidden'].map((ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0))).join('')
    for (const text of [`Plain ${smuggled} text.`, `Flag \u{1f3f4}${smuggled}\u{e007f} text.`]) {
      const got = parseChangelogLine(`Changelog: ${text}`)
      expect(got.text).not.toMatch(/[\u{e0000}-\u{e007f}]/u)
      expect(got.warnings.join('|')).toMatch(/strip/i)
    }
  })

  it('strips every invisible code point from published text and warns', () => {
    const property = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u
    const found = []
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      if (cp >= 0x09 && cp <= 0x0d) continue // ordinary whitespace is collapsed, not stripped
      if (property.test(String.fromCodePoint(cp))) found.push(cp)
    }
    const bad = []
    for (const cp of [...found, 0x2065, 0x0378, 0xfff0, 0xe0fff, 0xe000, 0xf8ff, 0xf0000]) {
      const got = parseChangelogLine(`Changelog: Plain${String.fromCodePoint(cp)} words stay.`)
      const clean = got.status === 'text' && got.text === 'Plain words stay.'
      if (!clean || !/strip/i.test(got.warnings.join('|'))) bad.push(cp.toString(16))
    }
    expect(bad).toEqual([])
  })
})

describe('credential and issue-id probe', () => {
  it('hides token-shaped sentences as parse-error, even with zero-width evasion', () => {
    for (const secret of [
      `ghp_${TOKEN}`,
      `github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwx`,
      'sk-proj1234567890abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
      JWT,
    ]) {
      expect(parseChangelogLine(`Changelog: Rotated ${secret} today.`).status, secret).toBe('parse-error')
    }
    for (const joiner of ['​', '‍', '⁠', '️', '­', '́', '\u{E0020}']) {
      expect(parseChangelogLine(`Changelog: Rotated gh${joiner}p_${TOKEN} today.`).status).toBe('parse-error')
      expect(
        parseChangelogLine(`Changelog: Rotated ghp_${TOKEN.slice(0, 8)}${joiner}${TOKEN.slice(8)} today.`).status,
      ).toBe('parse-error')
    }
    expect(parseChangelogLine('Changelog: Task-based risk-free flows are faster.').status).toBe('text')
  })

  it('hides a sentence that names an issue id', () => {
    for (const text of ['CHE-123 add Y', 'Fixed login (CHE-1634) for good.', 'see che-12 for details']) {
      const got = parseChangelogLine(`Changelog: ${text}`)
      expect(got.status, text).toBe('parse-error')
      expect(got.warnings.join('|')).toMatch(/issue id/i)
    }
    expect(parseChangelogLine('Changelog: The CHEESE-free flow is faster.').status).toBe('text')
  })

  it('is not fooled by combining marks, dash look-alikes or full-width letters', () => {
    const marks = ['̀', '́', '̂', '̈', '̌', '̧']
    const families = [
      (m) => `g${m}hp_${TOKEN}`,
      (m) => `github_pat_${TOKEN.slice(0, 4)}${m}${TOKEN.slice(4)}`,
      (m) => `s${m}k-proj1234567890abcdefghijkl`,
      (m) => `A${m}KIAIOSFODNN7EXAMPLE`,
      (m) => `C${m}HE-123`,
      (m) => `CHE-1${m}23`,
    ]
    for (const family of families) {
      for (const mark of marks) {
        expect(parseChangelogLine(`Changelog: Rotated ${family(mark)} today.`).status).toBe('parse-error')
      }
    }
    for (const dash of ['‐', '‑', '‒', '–', '—', '−', '－']) {
      expect(parseChangelogLine(`Changelog: Fixed CHE${dash}123 today.`).status).toBe('parse-error')
      expect(parseChangelogLine(`Changelog: Rotated sk${dash}proj1234567890abcdefghijkl today.`).status).toBe(
        'parse-error',
      )
    }
    expect(parseChangelogLine('Changelog: Fixed ＣＨＥ-１２３ today.').status).toBe('parse-error')
    expect(parseChangelogLine('Changelog: Café menus and naïve users keep accents.').status).toBe('text')
  })
})

describe('user-facing paths', () => {
  it('lists the doop product paths and the extensions', () => {
    for (const path of [
      'src/App.tsx',
      'server/index.ts',
      'shared/types.ts',
      'public/logo.svg',
      'desktop/src-tauri/main.rs',
      'android/app/build.gradle.kts',
      'ios/Blitz/App.swift',
      'chrome-extension/manifest.json',
      'claude-extension/manifest.json',
      'chatgpt-plugin/openapi.yaml',
      'cursor-plugin/plugin.json',
    ]) {
      expect(isUserFacingPath(path), path).toBe(true)
    }
    for (const path of [
      '.github/workflows/ci.yml',
      'scripts/changelog-line.mjs',
      'tests/access.test.ts',
      'docs/webhooks.md',
      'deploy/c00/compose.yml',
      'README.md',
      'srcs/x.ts',
      'docs/src/x.md',
    ]) {
      expect(isUserFacingPath(path), path).toBe(false)
    }
  })
})

describe('evaluatePr', () => {
  it('accepts a valid line on a feat, fix or perf PR and publishes the sentence', () => {
    for (const type of ['feat', 'fix', 'perf']) {
      const got = evaluatePr(pr({ title: `${type}(x): y`, body: `Changelog(${type}): Works now.` }))
      expect(got).toMatchObject({ kind: 'entry', text: 'Works now.' })
      expect(formatCheck(got).failing).toBe(false)
    }
  })

  it('fails a feat, fix or perf PR with a missing, placeholder, credential or issue-id line', () => {
    for (const body of ['', 'no line here', 'Changelog: <sentence>', `Changelog: ${JWT}`, 'Changelog: CHE-9 add Y']) {
      for (const type of ['feat', 'fix', 'perf']) {
        const got = evaluatePr(pr({ title: `${type}: x`, body, files: ['src/a.ts'] }))
        expect(got.kind, `${type} ${body}`).toBe('fail')
        expect(formatCheck(got).failing).toBe(true)
      }
    }
  })

  it('accepts "Changelog: none" when the PR touches only internal paths', () => {
    const got = evaluatePr(
      pr({
        title: 'fix(ci): x',
        body: 'Changelog: none',
        files: ['.github/workflows/ci.yml', 'scripts/a.mjs', 'tests/a.ts'],
      }),
    )
    expect(got.kind).toBe('none')
    expect(formatCheck(got).failing).toBe(false)
  })

  it('refuses "Changelog: none" when the PR touches a user-facing path, and names it', () => {
    for (const files of [['src/a.ts'], ['scripts/a.mjs', 'server/b.ts'], ['docs/a.md', 'ios/Blitz/x.swift']]) {
      const got = evaluatePr(pr({ title: 'feat: x', body: 'Changelog: none', files }))
      expect(got.kind).toBe('fail')
      expect(got.reason).toBe('none-on-user-facing')
      expect(formatCheck(got).line).toMatch(/none/)
      expect(formatCheck(got).failing).toBe(true)
    }
    const named = formatCheck(
      evaluatePr(pr({ title: 'fix: x', body: 'Changelog: none', files: ['docs/a.md', 'server/b.ts'] })),
    )
    expect(named.line).toContain('server/b.ts')
    expect(named.line).not.toContain('docs/a.md')
  })

  it('does not require a line on other PR types, even when it touches user-facing paths', () => {
    for (const title of ['ci(doop): x', 'chore: x', 'docs: x', 'refactor(src): x', 'test: x', 'no conventional type']) {
      for (const body of ['', 'Changelog: none', 'Changelog: <sentence>']) {
        const got = evaluatePr(pr({ title, body, files: ['src/a.ts'] }))
        expect(formatCheck(got).failing, `${title} / ${body}`).toBe(false)
      }
    }
  })

  it('skips a PR whose base is not cheese/main', () => {
    for (const baseRef of ['feature/stack-1', 'main', 'release']) {
      const got = evaluatePr(pr({ baseRef, title: 'feat: x', body: '' }))
      expect(got).toMatchObject({ kind: 'skip', reason: 'base' })
      expect(formatCheck(got).failing).toBe(false)
    }
  })

  it('skips an upstream sync title, whatever the body and files hold', () => {
    for (const title of [
      'task(doop): merge upstream doop 0.17.0 into cheese/main',
      'feat(doop): Merge upstream doop 0.17.0 into cheese/main',
    ]) {
      const got = evaluatePr(pr({ title, body: '', files: ['src/a.ts'] }))
      expect(got).toMatchObject({ kind: 'skip', reason: 'upstream-sync' })
      expect(formatCheck(got).failing).toBe(false)
    }
    // the words in a body do not make a skip
    expect(evaluatePr(pr({ title: 'feat: x', body: 'merge upstream doop' })).kind).toBe('fail')
  })

  it('reads the type from a scoped, breaking or upper-case title', () => {
    expect(titleType('feat(x)!: y')).toBe('feat')
    expect(titleType('FIX: y')).toBe('fix')
    expect(titleType('Update the thing')).toBe(null)
    expect(titleType(undefined)).toBe(null)
  })

  it('prints the entry line and the re-run note on failure', () => {
    expect(formatCheck(evaluatePr(pr())).line).toBe('Entry: "The selection now survives a zoom."')
    const failing = formatCheck(evaluatePr(pr({ body: '' })))
    expect(failing.line).toMatch(/^Missing:/)
    expect(failing.message).toMatch(/new commit or re-run/i)
  })
})

describe('CLI', () => {
  const run = (input, { files = ['src/a.ts'], env = {} } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-line-'))
    try {
      const prFile = join(dir, 'pr.json')
      const filesFile = join(dir, 'files.txt')
      const summary = join(dir, 'summary.md')
      writeFileSync(prFile, JSON.stringify(input))
      writeFileSync(filesFile, files.join('\n') + '\n')
      const res = spawnSync('node', [SCRIPT, '--pr', prFile, '--files', filesFile], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary, ...env },
      })
      return { ...res, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const input = (over = {}) => ({ title: 'fix: x', body: 'Changelog: Works now.', baseRef: 'cheese/main', ...over })

  it('passes a valid line and writes the entry to the job summary', () => {
    const res = run(input())
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Entry: "Works now."')
    expect(res.summary).toContain('Entry: "Works now."')
  })

  it('fails a feat PR without a line, with an error annotation and the re-run note', () => {
    const res = run(input({ title: 'feat: x', body: '' }))
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/::error::/)
    expect(res.stdout).toMatch(/new commit or re-run/i)
    expect(res.summary).toMatch(/Missing/)
  })

  it('fails "none" on a user-facing path and passes it on an internal one', () => {
    expect(run(input({ title: 'fix: x', body: 'Changelog: none' }), { files: ['src/a.ts'] }).status).toBe(1)
    expect(run(input({ title: 'fix: x', body: 'Changelog: none' }), { files: ['scripts/a.mjs'] }).status).toBe(0)
  })

  it('skips with exit 0 for another base and for an upstream sync', () => {
    const base = run(input({ title: 'feat: x', body: '', baseRef: 'stack/1' }))
    expect(base.status).toBe(0)
    expect(base.stdout).toMatch(/Skipped/)
    const sync = run(input({ title: 'task(doop): merge upstream doop 0.17.0 into cheese/main', body: '' }))
    expect(sync.status).toBe(0)
    expect(sync.stdout).toMatch(/Skipped/)
  })

  it('annotates warnings', () => {
    const res = run(input({ body: `Changelog: ${'d'.repeat(150)}` }))
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/::warning::Truncated/)
  })

  it('exits 1 on bad arguments or unreadable input, never 0', () => {
    expect(spawnSync('node', [SCRIPT], { encoding: 'utf8' }).status).toBe(1)
    expect(
      spawnSync('node', [SCRIPT, '--pr', '/nonexistent', '--files', '/nonexistent'], { encoding: 'utf8' }).status,
    ).toBe(1)
  })
})

describe('commit-message job in ci.yml', () => {
  const ci = readFileSync(new URL('.github/workflows/ci.yml', ROOT), 'utf8')
  const job = ci.slice(ci.indexOf('\n  commit-message:'), ci.indexOf('\n  typecheck:'))

  it('re-runs when the PR title or body is edited, so a stale green check cannot outlive an edit', () => {
    const trigger = /^ {2}pull_request:\n(?: {4}#[^\n]*\n)* {4}types: \[([^\]]*)\]/m.exec(ci)
    expect(trigger, 'pull_request must list its activity types').not.toBeNull()
    const types = trigger[1].split(',').map((type) => type.trim())
    // `edited` is the one that fires on a title, body or base change; the rest keep the default set
    expect(types.sort()).toEqual(['edited', 'opened', 'reopened', 'synchronize'])
  })

  it('has the guard step with no continue-on-error', () => {
    expect(job).toContain('changelog-line.mjs')
    expect(job).not.toMatch(/continue-on-error/)
    expect(ci).not.toMatch(/continue-on-error/)
  })

  it('runs the checker from the PR base SHA and reads the head only as data', () => {
    expect(job).toMatch(/git show "\$BASE_SHA:scripts\/changelog-line\.mjs"/)
    expect(job).toMatch(/gh api .*pulls\/\$\{?PR_NUMBER\}?\/files/)
  })

  it('passes attacker-controlled text through env, never inlined into the script', () => {
    const run = job.slice(job.indexOf('Changelog line'))
    expect(run).not.toMatch(/\$\{\{\s*github\.event\.pull_request\.(title|body)/)
    expect(run).not.toMatch(/\$\{\{[^}]*\}\}[^\n]*(node|git show|gh api)/)
  })
})

describe('PR template', () => {
  const template = readFileSync(new URL('.github/pull_request_template.md', ROOT), 'utf8')

  it('carries the line and one example, and the template line itself is not a valid line', () => {
    expect(template).toContain('Changelog(feat|fix|perf): ')
    expect(template).toMatch(/Example/i)
    expect(parseChangelogLine(template).status).toBe('missing')
  })
})
