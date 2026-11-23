import type { Decorator, Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, type ReactNode } from 'react'
import { PanelState } from '@/components/PanelState'
import { LockIcon } from '@/components/ui/icons'
import { useStore } from '@/lib/store'

/**
 * The shared states of the lifecycle panels (frame lock, Archive and Trash,
 * comment threads): loading, empty, error with a retry, and the offline
 * banner. The copy below is the approved lifecycle design's A1 state row
 * (design/lifecycle-ui/approved @ 572cc77). The connection is one global
 * flag, so each state is its own story; every action turns off while it is
 * down.
 */
const meta = { title: 'Shell/PanelState' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

function Connection({ connected, children }: { connected: boolean; children: ReactNode }) {
  useEffect(() => {
    useStore.setState({ connected })
    return () => useStore.setState({ connected: true })
  }, [connected])
  return (
    <section className="flex min-h-[150px] max-w-[360px] flex-col gap-2 rounded-card bg-surface p-3.5 shadow-ring">
      {children}
    </section>
  )
}

const connection =
  (connected: boolean): Decorator =>
  (Story) => (
    <Connection connected={connected}>
      <Story />
    </Connection>
  )

const noop = () => undefined
const lockAction = { label: 'Lock frame', onClick: noop, icon: <LockIcon /> }
const NOTHING_LOCKED = {
  title: 'No locked frames',
  hint: 'Lock a frame to keep it from edits. Right-click a frame, or press Cmd+Shift+L.',
}

export const Loading: Story = {
  decorators: [connection(true)],
  render: () => <PanelState status="loading" loadingLabel="Reading lock state…" />,
}

export const Empty: Story = {
  decorators: [connection(true)],
  render: () => <PanelState status="empty" empty={{ ...NOTHING_LOCKED, action: lockAction }} />,
}

export const ErrorWithRetry: Story = {
  decorators: [connection(true)],
  render: () => (
    <PanelState status="error" error="Could not unlock Cart · phone (403). It is still locked." onRetry={noop} />
  ),
}

export const Disconnected: Story = {
  decorators: [connection(false)],
  render: () => (
    <PanelState
      status="empty"
      empty={{ ...NOTHING_LOCKED, action: lockAction }}
      offline="Offline. Lock and unlock are paused. Locked frames stay locked."
    />
  ),
}
