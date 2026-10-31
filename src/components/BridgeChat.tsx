import { useEffect, useMemo, useState } from 'react'
import type { BridgeInfo, BridgeStatus } from '../../shared/bridge'
import { canvasPages } from '../../shared/pages'
import { api } from '../lib/api'
import { chatThread, FAILURE_TAGS } from '../lib/bridgeChat'
import { isComposingEnter } from '../lib/keys'
import { timeAgo } from '../lib/time'
import { useStore } from '../lib/store'
import { isResidentLimit } from './TeamAllowance'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { ArrowUpIcon } from './ui/icons'
import { Note } from './ui/note'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Textarea } from './ui/textarea'

/** The watcher stamps every few seconds; the bridge turns stale after two minutes. */
const REFRESH_MS = 30_000

type Banner = { tone: 'neutral' | 'error'; text: string }

/** What the user reads for a bridge that cannot take a message, cause in words. */
function statusBanner(status: BridgeStatus, agentName: string | null): Banner | null {
  switch (status) {
    case 'ok':
      return null
    case 'no_agent_selected':
      return { tone: 'neutral', text: 'Pick an agent to chat with.' }
    case 'agent_not_found':
      return {
        tone: 'error',
        text: `${agentName ?? 'The selected agent'} is not in the live Multica agent list. It may have been renamed or archived. Pick another agent.`,
      }
    case 'watcher_unreachable':
      return {
        tone: 'error',
        text: 'Multica is unreachable: the watcher has not reported for 2 minutes, so nothing would relay your message. Sending is off until it reports again.',
      }
  }
}

const NOT_LINKED: Banner = {
  tone: 'error',
  text: 'This canvas is not linked to a Multica issue, so the agent has nowhere to read your message. Link an issue to this canvas, then send again.',
}

/**
 * Chat with a Multica agent from the Agents tab. The picker writes the
 * canvas's choice to the bridge; a message is a canvas comment that starts
 * with the agent's handle, which the watcher relays to the linked issue. The
 * agent's answer returns as a reply in that comment's thread. doop never calls
 * Multica itself: "unreachable" is the watcher's stale stamp.
 */
export function BridgeChat({ canvasId }: { canvasId: string }) {
  const [bridge, setBridge] = useState<BridgeInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pickFailed, setPickFailed] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const comments = useStore((s) => s.comments)
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)

  useEffect(() => {
    let live = true
    const load = () =>
      api
        .getBridge(canvasId)
        .then((next) => {
          if (!live) return
          setBridge(next)
          setLoadFailed(false)
        })
        .catch((err) => {
          console.error(err)
          if (live) setLoadFailed(true)
        })
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [canvasId])

  const agentRef = bridge?.agentRef ?? null
  const lines = useMemo(() => (agentRef ? chatThread(comments, agentRef) : []), [comments, agentRef])
  const failure = lines.at(-1)?.tag
  const banner: Banner | null = loadFailed
    ? { tone: 'error', text: 'Could not read the chat bridge. Check the connection; this retries on its own.' }
    : bridge
      ? (statusBanner(bridge.status, bridge.agentName) ??
        (failure && (FAILURE_TAGS as readonly string[]).includes(failure) ? NOT_LINKED : null))
      : null
  const canSend = bridge?.status === 'ok' && !loadFailed && !sending && draft.trim() !== ''

  async function pick(next: string) {
    setPickFailed(false)
    try {
      setBridge(await api.putBridge(canvasId, next))
    } catch (err) {
      console.error(err)
      setPickFailed(true)
    }
  }

  async function send() {
    const pageId = activePageId ?? (canvas ? canvasPages(canvas)[0]?.id : undefined)
    if (!canSend || !agentRef || !pageId) return
    setSending(true)
    setSendFailed(false)
    try {
      await api.addCanvasComment(canvasId, { pageId, x: 0, y: 0, text: `@${agentRef} ${draft.trim()}` })
      setDraft('')
    } catch (err) {
      setSendFailed(true)
      if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
      else console.error(err)
    } finally {
      setSending(false)
    }
  }

  /* a selected agent the watcher no longer lists stays visible, so the trigger names what is broken */
  const agents = bridge?.agents ?? []
  const staleName = agentRef && !agents.some((a) => a.ref === agentRef) ? (bridge?.agentName ?? agentRef) : null

  return (
    <section aria-label="Chat with a Multica agent" className="flex flex-col gap-2 px-3 py-2">
      <Select value={agentRef ?? ''} onValueChange={(next) => void pick(next)} disabled={!bridge}>
        <SelectTrigger size="sm" aria-label="Multica agent">
          <SelectValue placeholder="Pick a Multica agent" />
        </SelectTrigger>
        <SelectContent>
          {staleName && agentRef && <SelectItem value={agentRef}>{staleName}</SelectItem>}
          {agents.map((a) => (
            <SelectItem key={a.ref} value={a.ref}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pickFailed && <Note tone="error">That choice did not save. Try again.</Note>}
      {banner && (
        <Callout role="alert" tone={banner.tone}>
          {banner.text}
        </Callout>
      )}
      {lines.length > 0 && (
        <ol aria-label="Chat thread" className="flex flex-col gap-1.5">
          {lines.map((l) => (
            <li key={l.id} data-slot="chat-line" className="text-label text-ink-soft">
              <span className="font-medium text-ink">{l.from}</span>{' '}
              <span className="text-caption text-ink-faint">{timeAgo(l.at)}</span>
              <p className="break-words whitespace-pre-wrap">{l.text}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-end gap-1.5">
        <Textarea
          variant="well"
          rows={1}
          aria-label="Message to the agent"
          placeholder="Message the agent…"
          className="min-h-8 flex-1 py-1.5 text-body"
          value={draft}
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isComposingEnter(e)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Button
          size="icon-sm"
          className="size-7 rounded-full"
          aria-label="Send to agent"
          disabled={!canSend}
          onClick={() => void send()}
        >
          <ArrowUpIcon className="size-3.5" strokeWidth={1.6} />
        </Button>
      </div>
      {sendFailed && <Note tone="error">That message did not go through. Your text is still here; try again.</Note>}
    </section>
  )
}
