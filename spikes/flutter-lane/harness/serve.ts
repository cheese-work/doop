// Stand-in doop pages for the two frame forms. Run with bun (imports the REAL frame runtime).
//   /player?form=nested&src=<flutter url>            form 1: HTML frame (srcdoc FRAME_BOOTSTRAP, sandbox="allow-scripts") + nested iframe + relay
//   /player?form=nested-norelay&src=...              form 1 without the relay (shows the player's source rule)
//   /player?form=kind&src=...&sandbox=<flags|none>   form 2: new frame kind, its own iframe policy
// usage: bun serve.ts <port> [coop-coep]
import { FRAME_BOOTSTRAP } from '../../../src/lib/frameRuntime.ts'

const port = Number(process.argv[2] ?? 18452)
const isolate = process.argv[3] === 'coop-coep'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function page(q: URLSearchParams): string {
  const src = q.get('src') ?? ''
  const form = q.get('form') ?? 'nested'
  const w = 390,
    h = 844
  if (form === 'multi') {
    // N instances of the same app in one page (canvas + player + matrix row), form-2 policy
    const n = Number(q.get('n') ?? 3)
    const sb = q.get('sandbox') ?? 'allow-scripts allow-same-origin'
    return `<!doctype html><body style="margin:0;display:flex;flex-wrap:wrap" id=row><script>
var SRC=${JSON.stringify(src)},N=${n};
function mk(i){var f=document.createElement('iframe');f.id='f'+i;f.setAttribute('sandbox',${JSON.stringify(sb)});f.setAttribute('allow','cross-origin-isolated');f.style.cssText='border:0;width:${Number(q.get('fw') ?? w)}px;height:${Number(q.get('fh') ?? h)}px';f.src=SRC;return f}
var ST=${Number(q.get('stagger') ?? 0)};for(var i=0;i<N;i++)(function(i){setTimeout(function(){document.getElementById('row').appendChild(mk(i))},i*ST)})(i);
window.remount=function(i){var o=document.getElementById('f'+i),f=mk(i);o.replaceWith(f)};
</script></body>`
  }
  if (form === 'kind') {
    const sb = q.get('sandbox') ?? 'allow-scripts allow-same-origin'
    const attr = sb === 'none' ? '' : ` sandbox="${esc(sb)}"`
    return `<!doctype html><body style="margin:0"><iframe src="${esc(src)}"${attr} allow="cross-origin-isolated" style="border:0;width:${w}px;height:${h}px"></iframe></body>`
  }
  const relay =
    form === 'nested'
      ? `<script>addEventListener('message',function(e){var f=document.querySelector('iframe');if(f&&e.source===f.contentWindow&&e.data&&String(e.data.type).indexOf('doop:flutter')===0)parent.postMessage(e.data,'*')})</script>`
      : ''
  const inner = `<html><body style="margin:0"><iframe src="${esc(src)}" allow="cross-origin-isolated" style="border:0;width:${w}px;height:${h}px"></iframe>${relay}</body></html>`
  // same wiring as PrototypePlayer.tsx: srcDoc bootstrap, wait for doop:frame-ready, then post the frame html
  return `<!doctype html><body style="margin:0"><iframe id=f sandbox="allow-scripts" srcdoc="${esc(FRAME_BOOTSTRAP)}" style="border:0;width:${w}px;height:${h}px"></iframe>
<script>
var f=document.getElementById('f'),html=${JSON.stringify(inner).replace(/</g, '\\u003c')};
addEventListener('message',function(e){if(e.source!==f.contentWindow)return;
 if(e.data&&e.data.type==='doop:frame-ready')f.contentWindow.postMessage({type:'doop:html',html:html,reqId:'proto'},'*')})
</script></body>`
}

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const u = new URL(req.url)
    if (u.pathname !== '/player') return new Response('not found', { status: 404 })
    const headers: Record<string, string> = { 'content-type': 'text/html' }
    if (isolate) {
      headers['cross-origin-opener-policy'] = 'same-origin'
      headers['cross-origin-embedder-policy'] = 'require-corp'
    }
    return new Response(page(u.searchParams), { headers })
  },
})
console.log(`player stand-in on 127.0.0.1:${port} isolate=${isolate}`)
