import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../src/lib/store'
import type { Canvas } from '../shared/types'

/**
 * Hand is the resting tool: the app starts in it and role demotion falls back
 * to it. (Esc and canvas switch are covered in the browser test.)
 */

const canvas = (role: Canvas['role']): Canvas =>
  ({ id: 'c', name: 'c', frames: [], pages: [], createdAt: 0, updatedAt: 0, role }) as Canvas

describe('default tool', () => {
  beforeEach(() => useStore.setState(useStore.getInitialState(), true))

  it('starts as Hand', () => {
    expect(useStore.getState().tool).toBe('hand')
  })

  it('falls back to Hand when a role demotion removes the active tool', () => {
    useStore.setState({ canvas: canvas('edit') })
    useStore.getState().setTool('rectangle')
    useStore.getState().setRole('view')
    expect(useStore.getState().tool).toBe('hand')
  })

  it('keeps Select when the role still allows it', () => {
    useStore.setState({ canvas: canvas('edit') })
    useStore.getState().setTool('select')
    useStore.getState().setRole('view')
    expect(useStore.getState().tool).toBe('select')
  })
})
