import { describe, expect, it } from 'vitest'
import { parse } from 'parse5'
import { PAGE_RULES } from '../shared/frameLint.ts'
import { SUBTREE_HASH_CAP, collectTree, repeatedMarkupRule } from '../shared/frameLintRepeated.ts'

/* S7 of the CHE-9115 plan (fl-r1): rule 25 `repeated-markup`, a pure function over parse5 facts. The boundary
   fixtures are the proof that the rule stays silent on Hallmark gate 82 (a counting device of empty marks) and gate 3
   (equal icon-above-heading tiles), the cases Hallmark already owns. */

type Frame = { id: string; html: string }

function run(frames: Frame[]) {
  const collected = frames.map((frame) => ({
    frame_id: frame.id,
    facts: repeatedMarkupRule.collect(frame.html),
  }))
  return repeatedMarkupRule.evaluate(collected)
}
const one = (html: string) => run([{ id: 'f1', html }])
const rows = (n: number, row: (i: number) => string) => Array.from({ length: n }, (_, i) => row(i)).join('')
const listRow = (i: number) =>
  `<li class="row"><span class="name">Item ${i}</span><span class="value">${i * 10}</span></li>`

describe('repeated-markup: the fixtures of the plan', () => {
  it('gives 1 finding for five identical text list rows', () => {
    const found = one(`<ul>${rows(5, listRow)}</ul>`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      frame_id: 'f1',
      rule: 'repeated-markup',
      level: 'warn',
      element: { selector: 'body > ul > li:nth-of-type(1)' },
    })
    expect(found[0]?.message).toContain('5 identical')
  })

  it('gives 0 for the gate 82 boundary: 30 identical empty dots', () => {
    expect(one(rows(30, () => '<span class="dot"></span>'))).toEqual([])
    expect(one(rows(30, () => '<span class="dot"><i></i></span>'))).toEqual([])
  })

  it('gives 0 for the gate 3 boundary: three equal icon-above-heading tiles', () => {
    const tiles = rows(
      3,
      (i) =>
        `<div class="tile"><svg viewBox="0 0 8 8"><path d="M0 0"></path></svg><h3>Title ${i}</h3><p>Body ${i}</p></div>`,
    )
    expect(one(`<section class="grid">${tiles}</section>`)).toEqual([])
    const imgTiles = rows(3, (i) => `<div class="tile"><img src="a.png"><h4>Title ${i}</h4><p>Body ${i}</p></div>`)
    expect(one(`<section>${imgTiles}</section>`)).toEqual([])
  })

  it('still flags tiles that put the heading first (not the gate 3 shape)', () => {
    const tiles = rows(
      3,
      (i) =>
        `<div class="tile"><h3>Title ${i}</h3><svg viewBox="0 0 8 8"><path d="M0 0"></path></svg><p>Body</p></div>`,
    )
    expect(one(`<section>${tiles}</section>`)).toHaveLength(1)
  })

  it('gives 0 findings on a clean page', () => {
    const clean = `
      <header><h1>Shop</h1><nav><a href="/">Home</a><a href="/cart">Cart</a></nav></header>
      <main><section class="hero"><h2>Sale</h2><p>Up to <b>40%</b> off</p></section>
      <ul>${rows(2, listRow)}</ul></main>
      <footer><p>Terms</p><p>Privacy</p></footer>`
    expect(one(clean)).toEqual([])
  })
})

describe('repeated-markup: the threshold and the hash', () => {
  it('needs 3 hits: two identical rows give 0, three give 1', () => {
    expect(one(`<ul>${rows(2, listRow)}</ul>`)).toEqual([])
    expect(one(`<ul>${rows(3, listRow)}</ul>`)).toHaveLength(1)
  })

  it('needs some text: three identical rows of empty marks give 0', () => {
    expect(one(rows(3, () => '<div class="card"><span class="a"></span><span class="b">  </span></div>'))).toEqual([])
  })

  it('needs 2 element descendants: three rows with one child give 0', () => {
    expect(one(rows(3, (i) => `<div class="card"><span>Item ${i}</span></div>`))).toEqual([])
    expect(one(rows(3, (i) => `<div class="card"><span>Item ${i}</span><b></b></div>`))).toHaveLength(1)
  })

  it('strips text: rows with different text and the same structure are one group', () => {
    expect(one(`<ul>${rows(4, listRow)}</ul>`)).toHaveLength(1)
  })

  it('does not group rows whose classes or inline style keys differ', () => {
    const mixed = `<ul>
      <li class="a"><span>1</span><span>x</span></li>
      <li class="b"><span>2</span><span>y</span></li>
      <li class="c"><span>3</span><span>z</span></li>
      <li style="color:red"><span>4</span><span>w</span></li>
      <li style="margin:0"><span>5</span><span>v</span></li>
      <li style="padding:0"><span>6</span><span>u</span></li></ul>`
    expect(one(mixed)).toEqual([])
  })

  it('treats class order, class repeats and style value as the same structure', () => {
    const same = `<ul>
      <li class="a b" style="color:red"><span>1</span><span>x</span></li>
      <li class="b a" style="color:blue;"><span>2</span><span>y</span></li>
      <li class="a b a" style="COLOR: green"><span>3</span><span>z</span></li></ul>`
    expect(one(same)).toHaveLength(1)
  })

  it('ignores script, style and template content', () => {
    const html = `<ul>${rows(3, listRow)}</ul><template>${rows(9, listRow)}</template><script>var a = "<li><b>1</b><i>2</i></li>"</script>`
    expect(one(html)).toHaveLength(1)
  })
})

describe('repeated-markup: components, nesting and frames', () => {
  it('skips subtrees that are, or sit inside, a component or an instance', () => {
    const asComponent = rows(5, (i) => `<li data-doop-component="Row"><span>${i}</span><span>x</span></li>`)
    expect(one(`<ul>${asComponent}</ul>`)).toEqual([])
    const asInstance = rows(5, (i) => `<li data-doop-instance="c1"><span>${i}</span><span>x</span></li>`)
    expect(one(`<ul>${asInstance}</ul>`)).toEqual([])
    const inside = rows(5, () => `<div data-doop-component="List"><ul>${rows(1, listRow)}</ul></div>`)
    expect(one(inside)).toEqual([])
  })

  it('reports the outer group once, not each repeated part inside it', () => {
    const card = (i: number) => `<div class="card"><h3>Card ${i}</h3><ul>${rows(3, listRow)}</ul></div>`
    const found = one(rows(3, card))
    expect(found).toHaveLength(1)
    expect(found[0]?.element?.selector).toBe('body > div:nth-of-type(1)')
  })

  it('counts hits across frames and reports on the first one', () => {
    const found = run([
      { id: 'f1', html: `<ul>${rows(2, listRow)}</ul>` },
      { id: 'f2', html: `<ul>${rows(1, listRow)}</ul>` },
      { id: 'f3', html: '<p>nothing</p>' },
    ])
    expect(found).toHaveLength(1)
    expect(found[0]?.frame_id).toBe('f1')
    expect(found[0]?.message).toContain('2 frames')
  })

  it('names the doop id of the first hit when it has one', () => {
    const html = `<ul>${rows(3, (i) => `<li data-doop-id="row-${i}"><span>${i}</span><span>x</span></li>`)}</ul>`
    expect(one(html)[0]?.element).toEqual({ doop_id: 'row-0', selector: '[data-doop-id="row-0"]' })
  })

  it('reports two different groups separately', () => {
    const html = `<ul>${rows(3, listRow)}</ul><div>${rows(4, (i) => `<p class="note"><b>N${i}</b><i>text</i></p>`)}</div>`
    expect(one(html)).toHaveLength(2)
  })
})

describe('repeated-markup: facts', () => {
  it('sets capped when a frame holds more candidates than the hash cap', () => {
    const many = rows(SUBTREE_HASH_CAP + 10, (i) => `<div class="c${i}"><b>a</b><i>b</i></div>`)
    const facts = collectTree(parse(many))
    expect(facts.capped).toBe(true)
    expect(facts.entries).toHaveLength(SUBTREE_HASH_CAP)
    expect(collectTree(parse('<ul>' + rows(3, listRow) + '</ul>')).capped).toBe(false)
  })

  it('collects a very deep tree without recursing, in well under a second', () => {
    const depth = 6000
    const tree = parse('<div><b>x</b>'.repeat(depth) + '</div>'.repeat(depth))
    const started = performance.now()
    const facts = collectTree(tree)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(facts.capped).toBe(true)
  }, 30_000)

  it('counts a capped frame and a frame with no facts as skipped, never as clean', () => {
    const many = rows(SUBTREE_HASH_CAP + 10, (i) => `<div class="c${i}"><b>a</b><i>b</i></div>`)
    const found = repeatedMarkupRule.evaluate([
      { frame_id: 'f1', facts: repeatedMarkupRule.collect(`<ul>${rows(3, listRow)}</ul>`) },
      { frame_id: 'f2', facts: repeatedMarkupRule.collect(many) },
      { frame_id: 'f3', facts: null },
    ])
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('considered 1 of 3 frames')
  })

  it('is registered in PAGE_RULES', () => {
    expect(PAGE_RULES).toContain(repeatedMarkupRule)
  })
})
