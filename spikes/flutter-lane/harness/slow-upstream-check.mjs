// A slow first compile upstream (X99 at load 60+) must not make the proxy drop the connection: the browser shows
// "didn't send any data" (ERR_EMPTY_RESPONSE) when the proxy closes after Bun's default 10 s idle timeout (CHE-7352).
// usage: node slow-upstream-check.mjs [delaySeconds=12]    Spawns a slow fake upstream and devproxy.ts on loopback.
import http from 'node:http'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const delay = Number(process.argv[2] ?? 12)
const UP = 18471,
  FRONT = 18472
const up = http.createServer((_, res) =>
  setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'), delay * 1000),
)
await new Promise((r) => up.listen(UP, '127.0.0.1', r))
const proxy = spawn('bun', ['devproxy.ts', String(UP), String(FRONT)], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: { ...process.env, IP: '127.0.0.1' },
  stdio: 'inherit',
})
await new Promise((r) => setTimeout(r, 1500))
const t0 = Date.now()
const result = await new Promise((resolve) => {
  https
    .get(
      { host: '127.0.0.1', port: FRONT, path: '/', rejectUnauthorized: false, headers: { 'accept-encoding': 'gzip' } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(`status ${res.statusCode}`))
      },
    )
    .on('error', (e) => resolve(`error ${e.code ?? e.message}`))
})
const s = ((Date.now() - t0) / 1000).toFixed(1)
proxy.kill()
up.close()
console.log(`upstream delay ${delay}s -> ${result} after ${s}s`)
process.exit(result === 'status 200' ? 0 : 1)
