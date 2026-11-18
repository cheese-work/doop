// X99 file watcher: a save under <dir> sends SIGUSR1 (stateful hot reload) to the flutter run process.
// usage: node watch.mjs <dir> <flutter.pid>
import fs from 'node:fs'
const [dir, pidFile] = process.argv.slice(2)
// one save emits 2 fs events (truncate + write); a 20 ms trailing debounce sends ONE signal after the write finished
let timer
fs.watch(dir, { recursive: true }, (_ev, name) => {
  if (!name?.endsWith('.dart')) return
  const t = Date.now()
  clearTimeout(timer)
  timer = setTimeout(() => {
    process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGUSR1')
    console.log(`${t} trigger ${name} (+${Date.now() - t} ms to signal)`)
  }, 20)
})
console.log(`watching ${dir}`)
