import { describe, expect, it } from 'vitest'
import { FRAME_RULES, type FactElement, type FrameFacts, type LintFinding } from '../shared/frameLint.ts'

/* S4 of the CHE-9115 plan (fl-r1): rules 1 `border-clipped`, 2 `text-clipped`, 4 `control-occluded` and
   16 `radius-bleed` on synthetic facts. Each rule is a pure function over what the collector saw. */

type Rect = { x: number; y: number; width: number; height: number }
const box = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

function el(over: Partial<FactElement> & Pick<FactElement, 'rect'>): FactElement {
  return { tag: 'div', selector: 'div', parent: -1, clipped_y: false, ...over }
}

function facts(elements: FactElement[], over: Partial<FrameFacts> = {}): FrameFacts {
  return {
    frame: { width: 393, height: 852 },
    viewport: { width: 393, height: 852 },
    applied: { colorScheme: 'light', lang: '', dir: 'ltr', fontScale: 1 },
    elements,
    capped: false,
    fonts_fell_back: false,
    colors: [],
    colors_capped: false,
    ...over,
  }
}

function run(id: string, f: FrameFacts): LintFinding[] {
  const rule = FRAME_RULES.find((candidate) => candidate.id === id)
  expect(rule, `rule ${id} is registered`).toBeDefined()
  return rule ? rule.run(f) : []
}

const NO_BORDER = { top: 0, right: 0, bottom: 0, left: 0 }

describe('border-clipped on synthetic facts', () => {
  it('reports a box whose right border lies outside an overflow clip', () => {
    const found = run(
      'border-clipped',
      facts([
        el({
          doop_id: 'field',
          selector: '[data-doop-id="field"]',
          rect: box(20, 100, 360, 40),
          border: { top: 1, right: 1, bottom: 1, left: 1 },
          clip: box(0, 0, 370, 852),
        }),
      ]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      rule: 'border-clipped',
      level: 'warn',
      viewport: { width: 393, height: 852 },
      element: { doop_id: 'field', selector: '[data-doop-id="field"]' },
    })
    expect(found[0]?.message).toContain('right')
    expect(found[0]?.message).toContain('10px')
  })

  it('reports every cut side that carries a border', () => {
    const found = run(
      'border-clipped',
      facts([
        el({
          rect: box(-6, 100, 200, 40),
          border: { top: 1, right: 1, bottom: 1, left: 1 },
          clip: box(0, 0, 393, 120),
        }),
      ]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toMatch(/left.*bottom|bottom.*left/)
  })

  it('stays silent when the box sits inside the clip', () => {
    expect(
      run(
        'border-clipped',
        facts([
          el({
            rect: box(20, 100, 300, 40),
            border: { top: 1, right: 1, bottom: 1, left: 1 },
            clip: box(0, 0, 393, 852),
          }),
        ]),
      ),
    ).toEqual([])
  })

  it('stays silent when the cut side has no border', () => {
    expect(
      run(
        'border-clipped',
        facts([el({ rect: box(20, 100, 400, 40), border: { ...NO_BORDER, left: 1 }, clip: box(0, 0, 393, 852) })]),
      ),
    ).toEqual([])
  })

  it('stays silent when the box is clipped away entirely (hidden, not a cut border)', () => {
    expect(
      run(
        'border-clipped',
        facts([
          el({
            rect: box(500, 100, 100, 40),
            border: { top: 1, right: 1, bottom: 1, left: 1 },
            clip: box(0, 0, 393, 852),
          }),
        ]),
      ),
    ).toEqual([])
  })

  it('stays silent within 1px of rounding', () => {
    expect(
      run(
        'border-clipped',
        facts([
          el({
            rect: box(20, 100, 373.6, 40),
            border: { top: 1, right: 1, bottom: 1, left: 1 },
            clip: box(0, 0, 393, 852),
          }),
        ]),
      ),
    ).toEqual([])
  })
})

describe('text-clipped on synthetic facts', () => {
  const label = (over: Partial<NonNullable<FactElement['text']>> = {}, elOver: Partial<FactElement> = {}) =>
    el({
      doop_id: 'label',
      selector: '[data-doop-id="label"]',
      rect: box(20, 100, 120, 20),
      text: { lines: [box(20, 100, 214, 20)], truncates: false, ...over },
      content_clip: box(20, 100, 120, 20),
      ...elOver,
    })

  it('reports text that an overflow box cuts', () => {
    const found = run('text-clipped', facts([label()]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      rule: 'text-clipped',
      level: 'error',
      element: { doop_id: 'label', selector: '[data-doop-id="label"]' },
    })
    expect(found[0]?.message).toContain('56% visible')
  })

  it('downgrades to warn when a font fell back, since the metrics may differ on the live image', () => {
    const found = run('text-clipped', facts([label()], { fonts_fell_back: true }))
    expect(found.map((f) => f.level)).toEqual(['warn'])
  })

  it('stays silent when the text fits the clip', () => {
    expect(run('text-clipped', facts([label({ lines: [box(20, 100, 100, 20)] })]))).toEqual([])
  })

  it('stays silent on an intentional truncation (ellipsis or line clamp)', () => {
    expect(run('text-clipped', facts([label({ truncates: true })]))).toEqual([])
  })

  it('stays silent when there is no clip at all', () => {
    expect(run('text-clipped', facts([label({}, { content_clip: undefined })]))).toEqual([])
  })

  it('cuts at the vertical axis too: the second line of a three-line paragraph', () => {
    const found = run(
      'text-clipped',
      facts([
        label(
          { lines: [box(20, 100, 120, 20), box(20, 120, 120, 20), box(20, 140, 120, 20)] },
          { content_clip: box(20, 100, 120, 30) },
        ),
      ]),
    )
    expect(found).toHaveLength(1)
  })

  it('stays silent within 1px of rounding', () => {
    expect(run('text-clipped', facts([label({ lines: [box(20, 100, 120.8, 20)] })]))).toEqual([])
  })
})

describe('control-occluded on synthetic facts', () => {
  const control = (kind: 'icon-button' | 'field' | 'image-link', occluded = true) =>
    el({
      tag: kind === 'field' ? 'input' : 'button',
      doop_id: 'ctl',
      selector: '[data-doop-id="ctl"]',
      rect: box(20, 100, 44, 44),
      control: {
        kind,
        ...(occluded ? { occluded_by: { tag: 'div', doop_id: 'scrim', selector: '[data-doop-id="scrim"]' } } : {}),
      },
    })

  it('reports an icon-only button, a field and an image link whose center another element covers', () => {
    for (const kind of ['icon-button', 'field', 'image-link'] as const) {
      const found = run('control-occluded', facts([control(kind)]))
      expect(found, kind).toHaveLength(1)
      expect(found[0]).toMatchObject({
        rule: 'control-occluded',
        level: 'error',
        element: { doop_id: 'ctl', selector: '[data-doop-id="ctl"]' },
      })
      expect(found[0]?.message).toContain('[data-doop-id="scrim"]')
    }
  })

  it('stays silent on a control nothing covers', () => {
    expect(run('control-occluded', facts([control('icon-button', false)]))).toEqual([])
  })

  it('stays silent on an element that is not a control with its own name-less box', () => {
    expect(run('control-occluded', facts([el({ rect: box(20, 100, 44, 44) })]))).toEqual([])
  })
})

describe('radius-bleed on synthetic facts', () => {
  const card = (over: Partial<FactElement> = {}) =>
    el({
      doop_id: 'card',
      selector: '[data-doop-id="card"]',
      rect: box(20, 100, 300, 200),
      radius: [16, 16, 16, 16],
      clips: false,
      paints_box: true,
      ...over,
    })
  const child = (rect: Rect, over: Partial<FactElement> = {}) =>
    el({
      doop_id: 'hero',
      selector: '[data-doop-id="hero"]',
      tag: 'img',
      rect,
      parent: 0,
      paints_box: true,
      ...over,
    })

  it('reports a painted child whose square corner sticks out of the rounded parent', () => {
    const found = run('radius-bleed', facts([card(), child(box(20, 100, 300, 120))]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      rule: 'radius-bleed',
      level: 'warn',
      element: { doop_id: 'hero', selector: '[data-doop-id="hero"]' },
    })
    expect(found[0]?.message).toContain('top-left')
  })

  it('names the cut when the parent clips the overflow through a bordered child', () => {
    const border = { top: 2, right: 2, bottom: 2, left: 2 }
    const found = run('radius-bleed', facts([card({ clips: true }), child(box(20, 100, 300, 120), { border })]))
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('cuts')
  })

  it('stays silent when the clip rounds a borderless child (the usual image-in-a-card pattern)', () => {
    expect(run('radius-bleed', facts([card({ clips: true }), child(box(20, 100, 300, 120))]))).toEqual([])
  })

  it('reports the bottom-right corner of a child that fills the card', () => {
    const found = run('radius-bleed', facts([card(), child(box(20, 180, 300, 120))]))
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('bottom-left')
  })

  it('stays silent on a child inset past the curve', () => {
    expect(run('radius-bleed', facts([card(), child(box(36, 116, 268, 100))]))).toEqual([])
  })

  it('stays silent when the child carries the same radius as the parent', () => {
    expect(run('radius-bleed', facts([card(), child(box(20, 100, 300, 120), { radius: [16, 16, 0, 0] })]))).toEqual([])
  })

  it('stays silent when the child paints nothing (a transparent wrapper)', () => {
    expect(run('radius-bleed', facts([card(), child(box(20, 100, 300, 120), { paints_box: false })]))).toEqual([])
  })

  it('stays silent when the parent has no radius, or its radius is invisible (no paint, no clip)', () => {
    expect(run('radius-bleed', facts([card({ radius: undefined }), child(box(20, 100, 300, 120))]))).toEqual([])
    expect(run('radius-bleed', facts([card({ paints_box: false }), child(box(20, 100, 300, 120))]))).toEqual([])
  })

  it('stays silent when the child reaches past the parent edge (plain overflow, not the radius)', () => {
    expect(run('radius-bleed', facts([card(), child(box(0, 100, 340, 120))]))).toEqual([])
  })

  it('reports the outermost bleeding box once, not its painted children too', () => {
    const found = run(
      'radius-bleed',
      facts([card(), child(box(20, 100, 300, 120), { selector: 'wrap' }), child(box(20, 100, 300, 60), { parent: 1 })]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.element?.selector).toBe('wrap')
  })

  it('finds the rounded ancestor through an unpainted wrapper', () => {
    const wrapper = el({ rect: box(20, 100, 300, 120), parent: 0, selector: 'wrap' })
    const found = run('radius-bleed', facts([card(), wrapper, child(box(20, 100, 300, 120), { parent: 1 })]))
    expect(found.map((f) => f.element?.doop_id)).toEqual(['hero'])
  })
})

describe('the registry', () => {
  it('registers the S4 rules after outside-frame', () => {
    expect(FRAME_RULES.map((rule) => rule.id)).toEqual([
      'outside-frame',
      'border-clipped',
      'text-clipped',
      'control-occluded',
      'radius-bleed',
    ])
  })

  it('stays silent on a frame of plain boxes (one clean frame, 0 findings)', () => {
    const clean = facts([
      el({ rect: box(0, 0, 393, 80) }),
      el({
        rect: box(20, 100, 353, 44),
        parent: 0,
        border: { top: 1, right: 1, bottom: 1, left: 1 },
        text: { lines: [box(30, 110, 100, 20)], truncates: false },
        content_clip: box(20, 100, 353, 44),
        clip: box(0, 0, 393, 852),
      }),
    ])
    for (const rule of FRAME_RULES) expect(rule.run(clean), rule.id).toEqual([])
  })
})
