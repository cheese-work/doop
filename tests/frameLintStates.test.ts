import { describe, expect, it } from 'vitest'
import { PAGE_RULES, type PageFinding } from '../shared/frameLint.ts'
import { STATE_CONTROL_CAP, statesPageRule } from '../shared/frameLintStates.ts'

/* S6 of the CHE-9115 plan (fl-r1), "Ask 5 states, per control": the state rules run over parse5 facts of every
   frame on the page and are pure functions, so no browser is involved. */

interface Frame {
  id: string
  html: string
  hidden?: boolean
  /** the scan skipped this frame (over the size cap): the rules get no facts for it */
  skipped?: boolean
}

function run(frames: Frame[]): PageFinding[] {
  return statesPageRule.evaluate(
    frames.map((f) => ({
      frame_id: f.id,
      ...(f.hidden ? { hidden: true } : {}),
      facts: f.skipped ? null : statesPageRule.collect(f.html),
    })),
  )
}

const rules = (found: PageFinding[]) => found.map((f) => `${f.frame_id}:${f.rule}`).sort()

const input = (attrs: string) => `<input type="text" ${attrs}>`

describe('registration', () => {
  it('registers the states rule in PAGE_RULES', () => {
    expect(PAGE_RULES.map((rule) => rule.id)).toContain('states')
  })
})

describe('each state rule fires on a control with no paired frame', () => {
  it('state-collapsed: a disclosure drawn in one state only', () => {
    const found = run([{ id: 'f1', html: '<button data-doop-id="more" aria-expanded="false">More</button>' }])
    expect(rules(found)).toEqual(['f1:state-collapsed'])
    expect(found[0]).toMatchObject({
      level: 'warn',
      element: { doop_id: 'more', selector: '[data-doop-id="more"]' },
    })
    expect(found[0]?.message).toContain('collapsed')
  })

  it('state-ime-open: a text input, textarea or contenteditable in a hi-fi frame', () => {
    const found = run([
      {
        id: 'f1',
        html: `${input('data-doop-id="a" aria-invalid="true"')}<textarea data-doop-id="b" aria-invalid="true"></textarea><div contenteditable data-doop-id="c"></div>`,
      },
    ])
    expect(rules(found)).toEqual(['f1:state-ime-open', 'f1:state-ime-open', 'f1:state-ime-open'])
  })

  it('state-error: a text input, select or textarea with no error drawn', () => {
    const found = run([
      {
        id: 'f1',
        html: `<div data-doop-stage="wireframe"></div>${input('data-doop-id="a"')}<select data-doop-id="b"></select><textarea data-doop-id="c"></textarea>`,
      },
    ])
    expect(rules(found)).toEqual(['f1:state-error', 'f1:state-error', 'f1:state-error'])
  })

  it('state-loading: a submit button with no loading state drawn', () => {
    const found = run([
      {
        id: 'f1',
        html: '<form><button data-doop-id="go">Go</button><button type="submit" data-doop-id="go2">Go</button><input type="submit" data-doop-id="go3"></form>',
      },
    ])
    expect(rules(found)).toEqual(['f1:state-loading', 'f1:state-loading', 'f1:state-loading'])
  })

  it('does not treat other controls as submit buttons or text fields', () => {
    const found = run([
      {
        id: 'f1',
        html: '<button type="button" data-doop-id="a">A</button><button data-doop-id="b">B</button><input type="checkbox" data-doop-id="c"><input type="hidden" data-doop-id="d"><input type="radio" data-doop-id="e">',
      },
    ])
    expect(found).toEqual([])
  })

  it('a doc-like page with no controls gives 0 findings', () => {
    expect(run([{ id: 'f1', html: '<h1>Title</h1><p>text</p>' }])).toEqual([])
  })
})

describe('what satisfies a rule: the same pairing identity in another frame', () => {
  it('state-collapsed: the other aria-expanded value on the same data-doop-id', () => {
    const closed = '<button data-doop-id="more" aria-expanded="false">More</button>'
    const open = '<button data-doop-id="more" aria-expanded="true">More</button>'
    expect(
      run([
        { id: 'f1', html: closed },
        { id: 'f2', html: open },
      ]),
    ).toEqual([])
  })

  it('state-ime-open: a frame marked ime-open that contains the same control', () => {
    const base = input('data-doop-id="email" aria-invalid="true"')
    const found = run([
      { id: 'f1', html: base },
      { id: 'f2', html: `<div data-doop-state="ime-open">${input('data-doop-id="email"')}</div>` },
    ])
    expect(found).toEqual([])
  })

  it('state-error: aria-invalid or data-doop-state="error" on the same control', () => {
    const plain = input('data-doop-id="email"')
    for (const marker of ['aria-invalid="true"', 'data-doop-state="error"']) {
      const found = run([
        { id: 'f1', html: plain },
        { id: 'f2', html: input(`data-doop-id="email" ${marker}`) },
      ])
      expect(rules(found).filter((r) => r.endsWith('state-error'))).toEqual([])
    }
  })

  it('state-loading: aria-busy or data-doop-state="loading" on the same control', () => {
    const plain = '<button type="submit" data-doop-id="pay">Pay</button>'
    for (const marker of ['aria-busy="true"', 'data-doop-state="loading"']) {
      const found = run([
        { id: 'f1', html: plain },
        { id: 'f2', html: `<button type="submit" data-doop-id="pay" ${marker}>Pay</button>` },
      ])
      expect(found).toEqual([])
    }
  })

  it('a data-doop-state-na with a reason on the control clears that state', () => {
    const found = run([
      {
        id: 'f1',
        html: `${input('data-doop-id="a" data-doop-state-na="error: read-only"')}<button data-doop-id="m" aria-expanded="true" data-doop-state-na="collapsed: always open">M</button><button type="submit" data-doop-id="s" data-doop-state-na="loading: instant">S</button>`,
      },
    ])
    expect(rules(found)).toEqual(['f1:state-ime-open'])
    const withIme = run([
      {
        id: 'f1',
        html: input('data-doop-id="a" aria-invalid="true" data-doop-state-na="ime-open: numeric keypad only"'),
      },
    ])
    expect(withIme).toEqual([])
  })

  it('a data-doop-state-na without a reason clears nothing', () => {
    const found = run([{ id: 'f1', html: input('data-doop-id="a" data-doop-state-na="error:  "') }])
    expect(rules(found)).toContain('f1:state-error')
  })

  it('pairs by the form-scoped key: same form id and same field name in both frames', () => {
    const login = (extra: string) => `<form id="login"><input type="text" name="email" ${extra}></form>`
    const found = run([
      { id: 'f1', html: login('') },
      { id: 'f2', html: login('aria-invalid="true"') },
    ])
    expect(rules(found)).toEqual(['f1:state-ime-open', 'f2:state-ime-open'])
  })

  it('pairs by a form with data-doop-id and a field with id', () => {
    const form = (extra: string) => `<form data-doop-id="signup"><input type="text" id="mail" ${extra}></form>`
    const found = run([
      { id: 'f1', html: form('') },
      { id: 'f2', html: form('aria-invalid="true"') },
    ])
    expect(rules(found).filter((r) => r.endsWith('state-error'))).toEqual([])
  })
})

describe('fixtures that must not clear a warning', () => {
  it('form#login and form#signup both have input[name=email]; only signup is shown invalid', () => {
    const found = run([
      { id: 'f1', html: '<form id="login"><input type="email" name="email"></form>' },
      { id: 'f2', html: '<form id="signup"><input type="email" name="email" aria-invalid="true"></form>' },
    ])
    expect(found.filter((f) => f.rule === 'state-error').map((f) => f.frame_id)).toEqual(['f1'])
  })

  it('two forms without an identity both have name="email": both get state-unpaired', () => {
    const found = run([
      { id: 'f1', html: '<form><input type="email" name="email"></form>' },
      { id: 'f2', html: '<form><input type="email" name="email" aria-invalid="true"></form>' },
    ])
    expect(found.filter((f) => f.rule === 'state-unpaired').map((f) => f.frame_id)).toEqual(['f1', 'f2'])
    expect(found.find((f) => f.frame_id === 'f1' && f.rule === 'state-unpaired')?.message).toContain('data-doop-id')
    expect(found.some((f) => f.rule === 'state-error')).toBe(false)
  })

  it('a second disclosure with the opposite aria-expanded value does not clear the first', () => {
    const found = run([
      { id: 'f1', html: '<button data-doop-id="faq-1" aria-expanded="false">One</button>' },
      { id: 'f2', html: '<button data-doop-id="faq-2" aria-expanded="true">Two</button>' },
    ])
    expect(rules(found)).toEqual(['f1:state-collapsed', 'f2:state-collapsed'])
  })

  it('an ime-open frame that contains a different input does not clear', () => {
    const found = run([
      { id: 'f1', html: input('data-doop-id="email" aria-invalid="true"') },
      { id: 'f2', html: `<div data-doop-state="ime-open">${input('data-doop-id="phone" aria-invalid="true"')}</div>` },
    ])
    expect(found.filter((f) => f.rule === 'state-ime-open').map((f) => f.frame_id)).toEqual(['f1'])
  })

  it('a match on page-wide name, id or role never pairs two controls without an identity', () => {
    const found = run([
      { id: 'f1', html: '<input type="text" name="email" id="email" aria-invalid="true">' },
      { id: 'f2', html: '<input type="text" name="email" id="email">' },
    ])
    expect(rules(found)).toEqual(['f1:state-unpaired', 'f2:state-unpaired'])
  })

  it('a key that matches two controls in one frame is ambiguous and pairs nothing', () => {
    const found = run([
      { id: 'f1', html: `${input('data-doop-id="dup"')}${input('data-doop-id="dup"')}` },
      { id: 'f2', html: input('data-doop-id="dup" aria-invalid="true"') },
    ])
    expect(found.filter((f) => f.rule === 'state-error').map((f) => f.frame_id)).toEqual(['f1', 'f1'])
  })
})

describe('what is out of scope', () => {
  it('skips elements inside a data-doop-component: G3 owns the states of a Components-page component', () => {
    const found = run([
      {
        id: 'f1',
        html: `<div data-doop-component="Field">${input('data-doop-id="a"')}<button type="submit" data-doop-id="b">Go</button><button data-doop-id="c" aria-expanded="false">C</button></div>`,
      },
    ])
    expect(found).toEqual([])
  })

  it('skips hidden frames and recon frames, as subjects and as evidence', () => {
    const plain = input('data-doop-id="email"')
    const found = run([
      { id: 'f1', html: plain },
      { id: 'f2', html: input('data-doop-id="email" aria-invalid="true"'), hidden: true },
      { id: 'f3', html: `<script type="application/json" id="doop-recon">{}</script>${plain}` },
    ])
    expect(rules(found)).toEqual(['f1:state-error', 'f1:state-ime-open'])
  })

  it('does not ask a wireframe for the ime-open state', () => {
    const found = run([
      { id: 'f1', html: `<div data-doop-stage="wireframe">${input('data-doop-id="a" aria-invalid="true"')}</div>` },
    ])
    expect(found).toEqual([])
  })
})

describe('a skipped frame', () => {
  it('makes the finding say "pairing incomplete: 1 frames skipped" and never clears it', () => {
    const found = run([
      { id: 'f1', html: input('data-doop-id="email" aria-invalid="true"') },
      { id: 'f2', html: input('data-doop-id="email" data-doop-state="error"'), skipped: true },
      { id: 'f3', html: input('data-doop-id="other"') },
    ])
    expect(found.length).toBeGreaterThan(0)
    for (const finding of found) expect(finding.message).toContain('pairing incomplete: 1 frames skipped')
    expect(rules(found)).toContain('f3:state-error')
  })

  it('without a skipped frame the message does not carry the note', () => {
    const [finding] = run([{ id: 'f1', html: input('data-doop-id="a"') }])
    expect(finding?.message).not.toContain('pairing incomplete')
  })

  it('treats a frame over the control cap as skipped', () => {
    const big = Array.from({ length: STATE_CONTROL_CAP + 1 }, (_, i) => input(`data-doop-id="c${i}"`)).join('')
    const found = run([
      { id: 'big', html: big },
      { id: 'f2', html: input('data-doop-id="x"') },
    ])
    expect(found.every((f) => f.frame_id === 'f2')).toBe(true)
    expect(found.length).toBeGreaterThan(0)
    for (const finding of found) expect(finding.message).toContain('pairing incomplete: 1 frames skipped')
  })
})

describe('a clean page', () => {
  it('gives 0 findings when every control has every state drawn', () => {
    const html = (state: string) =>
      `<div ${state}><button data-doop-id="more" aria-expanded="${state ? 'true' : 'false'}">M</button>${input(`data-doop-id="email" ${state ? 'aria-invalid="true"' : ''}`)}<button type="submit" data-doop-id="pay" ${state ? 'aria-busy="true"' : ''}>Pay</button></div>`
    expect(
      run([
        { id: 'f1', html: html('') },
        { id: 'f2', html: html('data-doop-state="ime-open"') },
      ]),
    ).toEqual([])
  })
})

describe('the facts', () => {
  it('give a selector that finds the control again', () => {
    const [finding] = run([
      { id: 'f1', html: `<main><p>x</p><section>${input('')}${input('aria-invalid="true"')}</section></main>` },
    ])
    expect(finding?.element).toEqual({ selector: 'main > section > input:nth-of-type(1)' })
  })

  it('read a deeply nested frame without recursion', { timeout: 30_000 }, () => {
    /* deeper than a recursive walk survives; parse5 itself is quadratic in depth, so keep it near that edge */
    const html = '<div>'.repeat(15000) + input('data-doop-id="deep"')
    expect(run([{ id: 'f1', html }]).map((f) => f.rule)).toEqual(['state-ime-open', 'state-error'])
  })
})
