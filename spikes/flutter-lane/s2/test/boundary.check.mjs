// Boundary rule of the S2 spike: the product library never builds a MaterialApp and never imports the harness;
// the harness owns the single MaterialApp. Plain text scan, runs with `node --test test/`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const dart = (dir) =>
  fs.existsSync(path.join(lib, dir))
    ? fs
        .readdirSync(path.join(lib, dir), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.dart'))
        .map((f) => [f, fs.readFileSync(path.join(lib, dir, f), 'utf8').replace(/\/\/.*$/gm, '')])
    : []
const count = (src, re) => (src.match(re) ?? []).length

test('product folder has no MaterialApp / CupertinoApp / WidgetsApp', () => {
  const files = dart('erus_home')
  assert.ok(files.length > 0, 'product files found')
  for (const [f, src] of files) assert.equal(count(src, /\b(MaterialApp|CupertinoApp|WidgetsApp)\b/g), 0, f)
})

test('product folder does not import the harness', () => {
  for (const [f, src] of dart('erus_home')) assert.doesNotMatch(src, /doop_harness/, f)
})

test('harness has exactly one MaterialApp', () => {
  const total = dart('doop_harness').reduce((n, [, src]) => n + count(src, /\bMaterialApp\s*\(/g), 0)
  assert.equal(total, 1)
})

test('main.dart wires the two and builds no app itself', () => {
  const src = fs.readFileSync(path.join(lib, 'main.dart'), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(src, /runDoop\(/)
  assert.equal(count(src, /\bMaterialApp\b/g), 0)
})
