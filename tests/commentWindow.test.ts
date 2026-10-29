import { beforeEach, describe, expect, it } from 'vitest'
import { pageThreads } from '../src/lib/comments'
import { useStore } from '../src/lib/store'
import type { ElementComment } from '../shared/types.ts'

const WINDOW = 100
const canvas = { id: 'c1', pages: [{ id: 'p1', name: 'Page 1' }], frames: [] }

const comment = (id: string, at: number, parentId?: string): ElementComment => ({
  id,
  canvasId: 'c1',
  selector: '',
  snippet: '',
  pageId: 'p1',
  x: 0,
  y: 0,
  from: 'alice',
  text: id,
  at,
  ...(parentId ? { parentId } : {}),
})

/* What a client sees when a reply lands on a thread that left the 100-entry window: the server
 * sends the stored thread oldest first, then the reply. */
describe('comment window on the client', () => {
  beforeEach(() => {
    const newest = Array.from({ length: WINDOW }, (_, i) => comment(`other-${i}`, 1000 + i)).reverse()
    useStore.getState().setComments(newest)
  })

  it('keeps the root and the newest reply of a restored full thread', () => {
    const root = comment('root', 1)
    const earlier = Array.from({ length: WINDOW - 1 }, (_, i) => comment(`reply-${i}`, 2 + i, 'root'))
    const reply = comment('reply-new', 5000, 'root')

    for (const c of [root, ...earlier, reply]) useStore.getState().upsertComment(c)

    const { comments } = useStore.getState()
    expect(comments.map((c) => c.id)).toEqual(expect.arrayContaining(['root', 'reply-new']))
    const [thread] = pageThreads(comments, canvas, 'p1')
    expect(thread?.root.id).toBe('root')
    expect(thread?.replies.at(-1)?.id).toBe('reply-new')
  })

  it('still caps unrelated comments at the window', () => {
    for (let i = 0; i < 20; i++) useStore.getState().upsertComment(comment(`new-${i}`, 3000 + i))
    expect(useStore.getState().comments).toHaveLength(WINDOW)
    expect(useStore.getState().comments[0]?.id).toBe('new-19')
  })
})
