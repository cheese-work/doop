// Drives the DartPad SDK worker protocol (sdk/doc/worker-protocol.md in package:dartpad 0.1.4) from plain JS:
// one worker per page, one sandbox iframe per Flutter frame. The Dart source reaches the browser as text
// (/src.json, then /events on every save). Nothing is compiled by this server: DDC runs in the worker, here.
const q = new URLSearchParams(location.search)
const N = Number(q.get('n') ?? 1)
const SDK = new URL('/sdk/', location.href).href
const T0 = performance.now()
const log = (...a) => { const s = `${Math.round(performance.now() - T0)} ms ${a.join(' ')}`; console.log(s); document.getElementById('log').textContent += s + '\n' }
const st = (s) => (document.getElementById('st').textContent = s)
const S = (window.s1b = { events: [], reloads: [], sandboxes: [] })

class Rpc { // JSON-RPC 2.0 over MessagePort: {payload: JSON string, port?, bytes?}
  constructor(port, onNote) {
    this.port = port; this.id = 0; this.pending = new Map(); this.onNote = onNote
    port.onmessage = (e) => {
      const { payload, port: p, bytes } = e.data ?? {}
      if (payload === undefined) return
      const m = JSON.parse(payload)
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id)
        if (m.error) rej(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data }))
        else { if (m.result && p) m.result.port = p; if (m.result && bytes) m.result.bytes = bytes; res(m.result) }
      } else if (m.method) this.onNote?.(m.method, m.params)
    }
  }
  request(method, params = {}, { port, bytes } = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.port.postMessage({ payload: JSON.stringify({ jsonrpc: '2.0', method, params, id }), ...(port && { port }), ...(bytes && { bytes }) }, port ? [port] : [])
    })
  }
}

function startWorker() {
  const loader = `try { const {Worker} = await import(${JSON.stringify(SDK + 'worker.js')}); const w = await Worker.create({});
    const {port1, port2} = new MessageChannel(); w.session(port1); self.postMessage({action:'session', port: port2}, [port2]) }
    catch (e) { console.error(e); self.postMessage({action:'error', message: String(e)}) }`
  const worker = new Worker(URL.createObjectURL(new Blob([loader], { type: 'text/javascript' })), { type: 'module', name: 'dartpad-worker' })
  return new Promise((res, rej) => {
    worker.onmessage = (e) => (e.data.action === 'session' ? res(e.data.port) : rej(new Error(e.data.message)))
    worker.onerror = (e) => rej(new Error('worker error: ' + e.message))
  })
}

function startSandbox(host) { // the sandbox iframe, as package:dartpad's createSandboxedIframe builds it
  const f = document.createElement('iframe')
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  f.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="${SDK}sandbox.js" defer></script><style>body{margin:0;overflow:hidden;background:transparent}</style></head><body></body></html>`
  return new Promise((res, rej) => {
    const on = (e) => {
      if (e.source !== f.contentWindow || !e.data?.action) return
      removeEventListener('message', on)
      e.data.action === 'connect' ? res({ iframe: f, port: e.data.port }) : rej(new Error('sandbox: ' + e.data.message))
    }
    addEventListener('message', on); host.appendChild(f)
  })
}

try {
  st('worker')
  const wport = await startWorker(); log('worker session')
  const consoleLines = (S.console = [])
  const rpc = new Rpc(wport, (m, p) => { if (m === 'workspace/sandbox/console') { consoleLines.push(`${p.level}: ${p.message}`); log('sandbox', p.sandboxId, p.level, p.message.slice(0, 200)) } })
  S.version = await rpc.request('version'); log('version', JSON.stringify(S.version))
  const { workspaceId } = await rpc.request('createWorkspace')
  const ws = (m, p = {}, x) => rpc.request('workspace/' + m, { workspaceId, ...p }, x)
  const files = await (await fetch('/src.json')).json()
  await ws('writeFileFromText', { path: 'pubspec.yaml', text: q.get('pubspec') ?? `name: erus_home_spike\nenvironment:\n  sdk: ^3.14.0\ndependencies:\n  flutter:\n    sdk: flutter\n  web: ^1.1.2\n` })
  for (const [n, text] of Object.entries(files)) await ws('writeFileFromText', { path: 'lib/' + n, text })
  st('pub get'); const t1 = performance.now()
  const pub = await ws('pub', { path: '.', command: 'get' }); log('pub get', Math.round(performance.now() - t1), 'ms', pub.log.slice(-200).replace(/\n/g, ' | '))
  S.pubGetMs = Math.round(performance.now() - t1)
  const host = document.getElementById('frames')
  for (let i = 0; i < N; i++) {
    st('sandbox ' + i)
    const { iframe, port } = await startSandbox(host)
    const { sandboxId } = await ws('connectSandbox', {}, { port })
    S.sandboxes.push({ sandboxId, iframe })
    log('sandbox connected', sandboxId)
  }
  st('compile')
  const t2 = performance.now()
  // one run per sandbox; the worker compiles per run, S1b step 5 records whether those runs share work
  await Promise.all(S.sandboxes.map((s) => ws('sandbox/run', { sandboxId: s.sandboxId, path: 'lib/main.dart', mode: 'flutter' }).then((r) => { s.runMs = Math.round(performance.now() - t2); log('run', s.sandboxId, s.runMs, 'ms') })))
  st('running'); S.ready = true

  const apply = async (text) => {
    const t = performance.now()
    for (const [n, body] of Object.entries(JSON.parse(text))) await ws('writeFileFromText', { path: 'lib/' + n, text: body })
    const tw = performance.now()
    const r = await Promise.all(S.sandboxes.map((s) => ws('sandbox/hotReload', { sandboxId: s.sandboxId }).then(() => Math.round(performance.now() - t))))
    S.reloads.push({ write: Math.round(tw - t), perSandbox: r }); log('hot reload', JSON.stringify(r)); st('reloaded in ' + Math.max(...r) + ' ms')
  }
  let chain = Promise.resolve() // reloads in order, never overlapping
  const es = new EventSource('/events')
  es.onmessage = (e) => { chain = chain.then(() => apply(e.data)).catch((err) => log('reload failed', err.message, err.code, JSON.stringify(err.data))) }
  if (q.get('edit')) { // ?edit=1: type in the box, the frame hot reloads 150 ms after the last key (a human-felt edit loop)
    const ta = document.getElementById('ed'); ta.hidden = false; ta.value = files['main.dart']; let tm
    ta.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { chain = chain.then(() => apply(JSON.stringify({ 'main.dart': ta.value }))).catch((err) => log('reload failed', err.message)) }, 150) }
  }
  setInterval(() => rpc.request('ping'), 30000)
  S.rpc = (m, p, x) => ws(m, p, x); S.raw = rpc
} catch (e) { st('FAILED'); S.error = String(e.message ?? e); log('FAILED', S.error, e.code ?? '', JSON.stringify(e.data ?? '')) }
