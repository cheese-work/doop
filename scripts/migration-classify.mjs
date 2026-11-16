// Migration classifier (C-8.4, CHE-5474 S4a). Splits a migration on `--> statement-breakpoint` and parses
// every statement with the Postgres parser. Additive is exactly:
//   CREATE TABLE IF NOT EXISTS;
//   ALTER TABLE ... ADD COLUMN IF NOT EXISTS, nullable or with a constant default (and no other constraint);
//   CREATE INDEX IF NOT EXISTS, not UNIQUE, not CONCURRENTLY.
// Everything else (DROP, RENAME, ALTER TYPE, UPDATE, DELETE, DO, a parse error) is not additive. Fails closed.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loadModule, parse } from 'libpg-query'

const BREAKPOINT = /^\s*-->\s*statement-breakpoint\s*$/m

// A constant default: a literal, or a literal cast to a type. Never a function call or an expression.
function isConstant(expr) {
  if (!expr) return false
  if (expr.A_Const) return true
  if (expr.TypeCast) return isConstant(expr.TypeCast.arg)
  return false
}

function column(def) {
  const cs = (def.constraints ?? []).map((c) => c.Constraint)
  let notNull = false
  let constantDefault = false
  for (const c of cs) {
    if (c.contype === 'CONSTR_NOTNULL') notNull = true
    else if (c.contype === 'CONSTR_NULL') continue
    else if (c.contype === 'CONSTR_DEFAULT' && isConstant(c.raw_expr)) constantDefault = true
    else return `column "${def.colname}" has constraint ${c.contype}`
  }
  if (def.is_from_type || def.collClause || def.fdwoptions) return `column "${def.colname}" has unsupported options`
  if (notNull && !constantDefault) return `column "${def.colname}" is NOT NULL without a constant default`
  return null
}

function classifyNode(stmt) {
  const [kind, body] = Object.entries(stmt)[0] ?? []
  switch (kind) {
    case 'CreateStmt':
      return body.if_not_exists ? null : 'CREATE TABLE without IF NOT EXISTS'
    case 'IndexStmt':
      if (!body.if_not_exists) return 'CREATE INDEX without IF NOT EXISTS'
      if (body.concurrent) return 'CREATE INDEX CONCURRENTLY'
      if (body.unique) return 'UNIQUE index'
      return null
    case 'AlterTableStmt': {
      if (body.objtype !== 'OBJECT_TABLE') return `ALTER ${body.objtype}`
      for (const { AlterTableCmd: cmd } of body.cmds ?? []) {
        if (cmd?.subtype !== 'AT_AddColumn') return `ALTER TABLE ${cmd?.subtype}`
        if (!cmd.missing_ok) return 'ADD COLUMN without IF NOT EXISTS'
        const bad = column(cmd.def.ColumnDef)
        if (bad) return bad
      }
      return null
    }
    default:
      return `${kind ?? 'unknown statement'} is not additive`
  }
}

export async function classifyMigration(sql) {
  await loadModule()
  const statements = []
  for (const chunk of sql.split(BREAKPOINT)) {
    if (!chunk.trim()) continue
    let stmts
    try {
      stmts = (await parse(chunk)).stmts ?? []
    } catch (e) {
      statements.push({ sql: chunk.trim(), additive: false, reason: `parse error: ${e.message}` })
      continue
    }
    for (const { stmt, stmt_location = 0, stmt_len } of stmts) {
      const text = chunk.slice(stmt_location, stmt_len ? stmt_location + stmt_len : undefined).trim()
      const reason = classifyNode(stmt)
      statements.push(reason ? { sql: text, additive: false, reason } : { sql: text, additive: true })
    }
  }
  return { additive: statements.every((s) => s.additive), statements }
}

// CLI: node scripts/migration-classify.mjs <dir> <name.sql>...   prints one result per file, exits 1 if any is not additive.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, ...names] = process.argv.slice(2)
  const migrations = []
  for (const name of names)
    migrations.push({ name, ...(await classifyMigration(await readFile(`${dir}/${name}`, 'utf8'))) })
  const additive = migrations.every((m) => m.additive)
  console.log(JSON.stringify({ additive, migrations }, null, 2))
  process.exit(additive ? 0 : 1)
}
