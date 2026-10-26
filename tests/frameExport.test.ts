// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { downloadFrameExport, downloadFrameExports, downloadFramesPdf } from '../src/lib/frameExport'
import { useStore } from '../src/lib/store'

const frame: Frame = {
  id: 'export-frame',
  canvasId: 'canvas',
  name: 'Poster',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
let clicked: HTMLAnchorElement[]

beforeEach(() => {
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this)
  })
  URL.createObjectURL = vi.fn(() => 'blob:export')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as { __DOOP_DESKTOP__?: string }).__DOOP_DESKTOP__
  useStore.setState({ notice: null })
})

it('shows a busy toast while rendering, then saves through a download link named by the server', async () => {
  let respond!: (res: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (respond = resolve))),
  )

  const done = downloadFrameExport(frame, 'psd')
  expect(fetch).toHaveBeenCalledWith('/i/export-frame.psd', expect.anything())
  expect(useStore.getState().notice).toMatchObject({ text: 'Exporting PSD…', busy: true })

  respond(new Response('psd-bytes', { headers: { 'Content-Disposition': 'attachment; filename="Poster.psd"' } }))
  await done

  expect(clicked).toHaveLength(1)
  expect(clicked[0]!.download).toBe('Poster.psd')
  expect(clicked[0]!.href).toBe('blob:export')
  expect(useStore.getState().notice).toMatchObject({ text: '“Poster.psd” is ready', busy: false })
})

it('reports the server error instead of saving a failed render', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'PSD export rate limit — wait a minute' }, { status: 429 })),
  )

  await downloadFrameExport(frame, 'psd')

  expect(clicked).toHaveLength(0)
  expect(useStore.getState().notice?.text).toBe('PSD export rate limit — wait a minute')
})

it('requests PNG and JPG at 2x', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('img')),
  )
  await downloadFrameExport(frame, 'png')
  await downloadFrameExport(frame, 'jpg')
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    '/i/export-frame.png?scale=2&download',
    '/i/export-frame.jpg?scale=2&download',
  ])
  expect(clicked.map((a) => a.download)).toEqual(['Poster.png', 'Poster.jpg'])
})

it('keeps the spinner up while another export is still rendering', async () => {
  const pending: ((res: Response) => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
  )

  const png = downloadFrameExport(frame, 'png')
  const psd = downloadFrameExport(frame, 'psd')
  pending[0]!(new Response('img', { headers: { 'Content-Disposition': 'attachment; filename="Poster.png"' } }))
  await png
  expect(useStore.getState().notice).toMatchObject({
    text: '“Poster.png” is ready · Exporting 1 more…',
    busy: true,
  })

  pending[1]!(new Response('psd', { headers: { 'Content-Disposition': 'attachment; filename="Poster.psd"' } }))
  await psd
  expect(useStore.getState().notice).toMatchObject({ text: '“Poster.psd” is ready', busy: false })
})

it('in the desktop shell leaves the outcome to the save panel, which may be cancelled', async () => {
  ;(globalThis as { __DOOP_DESKTOP__?: string }).__DOOP_DESKTOP__ = '0.4.0'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('img')),
  )

  await downloadFrameExport(frame, 'png')

  expect(clicked).toHaveLength(1)
  expect(useStore.getState().notice).toBeNull()
})

it('exports a batch one at a time and waits out the server’s limit instead of dropping frames', async () => {
  const other = { ...frame, id: 'other-frame', name: 'Flyer' }
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls += 1
      if (calls === 2) {
        return Response.json(
          { error: 'PSD export rate limit — wait a minute' },
          { status: 429, headers: { 'Retry-After': '1' } },
        )
      }
      const name = url.startsWith('/i/other-frame') ? 'Flyer' : 'Poster'
      return new Response('psd', { headers: { 'Content-Disposition': `attachment; filename="${name}.psd"` } })
    }),
  )

  vi.useFakeTimers()
  const done = downloadFrameExports([frame, other], 'psd')
  /* the first frame saves and the second hits the limit — all microtasks */
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  expect(useStore.getState().notice).toMatchObject({
    text: 'Exporting PSD 2 of 2 — waiting 1s for the export limit…',
    busy: true,
  })
  await vi.advanceTimersByTimeAsync(999)
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  await done
  vi.useRealTimers()

  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    '/i/export-frame.psd',
    '/i/other-frame.psd',
    '/i/other-frame.psd',
  ])
  expect(clicked.map((a) => a.download)).toEqual(['Poster.psd', 'Flyer.psd'])
  expect(useStore.getState().notice).toMatchObject({ text: '2 PSDs ready', busy: false })
})

it('reports how many of a batch were saved when a frame keeps failing', async () => {
  const other = { ...frame, id: 'other-frame', name: 'Flyer' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/i/other-frame')
        ? Response.json({ error: 'PSD export failed' }, { status: 500 })
        : new Response('psd', { headers: { 'Content-Disposition': 'attachment; filename="Poster.psd"' } }),
    ),
  )

  await downloadFrameExports([frame, other], 'psd')

  expect(clicked.map((a) => a.download)).toEqual(['Poster.psd'])
  expect(useStore.getState().notice?.text).toBe('1 of 2 PSDs saved — PSD export failed')
})

it('waits the default minute when a 429 arrives without Retry-After', async () => {
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      calls += 1
      return calls === 1
        ? Response.json({ error: 'PSD export rate limit — wait a minute' }, { status: 429 })
        : new Response('psd', { headers: { 'Content-Disposition': 'attachment; filename="Poster.psd"' } })
    }),
  )
  vi.useFakeTimers()
  const done = downloadFrameExports([frame], 'psd')
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(useStore.getState().notice?.text).toBe('Exporting PSD — waiting 60s for the export limit…')
  await vi.advanceTimersByTimeAsync(60_000)
  await done
  vi.useRealTimers()
  expect(clicked.map((a) => a.download)).toEqual(['Poster.psd'])
})

it('settles and reports when starting the download throws', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('psd', { headers: { 'Content-Disposition': 'attachment; filename="Poster.psd"' } })),
  )
  vi.mocked(URL.createObjectURL).mockImplementation(() => {
    throw new Error('blocked')
  })

  await downloadFrameExports([frame], 'psd')

  expect(useStore.getState().notice).toMatchObject({
    text: '0 of 1 PSDs saved — Couldn’t save “Poster.psd”',
    busy: false,
  })
})

it('binds several frames into one PDF request and saves the file the server names', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('%PDF-1.7', {
          headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Deck.pdf"' },
        }),
    ),
  )

  await downloadFramesPdf('canvas', [frame, { ...frame, id: 'second' }])

  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/canvases/canvas/export.pdf?frames=export-frame,second',
    expect.anything(),
  )
  expect(clicked[0]!.download).toBe('Deck.pdf')
  expect(useStore.getState().notice).toMatchObject({ text: '“Deck.pdf” is ready', busy: false })
})

it('shows why a PDF could not be made, such as a server without a browser', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'PDF export is unavailable' }, { status: 503 })),
  )

  await downloadFramesPdf('canvas', [frame])

  expect(clicked).toHaveLength(0)
  expect(useStore.getState().notice?.text).toBe('PDF export is unavailable')
})

it('gives a PDF of many frames longer than a single frame to render', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('%PDF-1.7', { headers: { 'Content-Type': 'application/pdf' } })),
  )

  await downloadFramesPdf('canvas', [frame])
  const many = Array.from({ length: 40 }, (_, index) => ({ ...frame, id: `frame-${index}` }))
  await downloadFramesPdf('canvas', many)

  /* one frame keeps the two-minute floor; forty print three at a time, a minute per wave */
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([2 * 60_000, 14 * 60_000])
})
