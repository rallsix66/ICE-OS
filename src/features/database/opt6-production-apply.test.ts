import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const normalizeLineEndings = (value: string) => value.replace(/\r\n/g, '\n')

describe('OPT-6 Batch 2 Production apply packet static contract', () => {
  let packet = ''
  let migration = ''

  beforeAll(() => {
    packet = normalizeLineEndings(readFileSync(
      resolve(process.cwd(), 'docs/reports/sql/2026-07-21-opt6-00051-production-apply.sql'),
      'utf8',
    ))
    migration = normalizeLineEndings(readFileSync(
      resolve(process.cwd(), 'supabase/migrations/00051_optimize_role_rls_policy_overlap.sql'),
      'utf8',
    ))
  })

  it('keeps one transaction and locks history before the embedded migration body', () => {
    expect(packet.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(packet.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(packet.indexOf('LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;'))
      .toBeLessThan(packet.indexOf('-- Migration 00051:'))
    expect(packet).toContain('LOCK TABLE public.sync_run IN SHARE MODE;')
  })

  it('rechecks the complete history payload and active-sync guard before policy DDL', () => {
    const bodyIndex = packet.indexOf('-- Migration 00051:')
    const preBody = packet.slice(0, bodyIndex)
    expect(preBody.match(/\('000\d{2}',/g)).toHaveLength(50)
    expect(preBody).toContain('FULL JOIN actual_history AS actual USING (version)')
    expect(preBody).toContain("array_to_string(statements, E'\\x1f')")
    expect(preBody).toContain('statement_count IS DISTINCT FROM expected.statement_count')
    expect(preBody).toContain('statement_chars IS DISTINCT FROM expected.statement_chars')
    expect(preBody).toContain('statement_digest IS DISTINCT FROM expected.statement_digest')
    expect(preBody).toContain("status = 'in_progress'")
    expect(preBody).toContain('RAISE EXCEPTION')
    expect(packet.indexOf('DROP POLICY')).toBeGreaterThan(bodyIndex)
  })

  it('embeds the canonical migration body byte-for-byte and repeats the old-history postcheck', () => {
    expect(packet.match(new RegExp(migration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2)
    const postBody = packet.slice(packet.lastIndexOf('WITH body AS'))
    expect(postBody).toContain('FULL JOIN actual_history AS actual USING (version)')
    expect(postBody).toContain("md5(statements[1]) = 'aee8d4811b5382afc9786ef0dae195be'")
    expect(postBody).toContain("status = 'in_progress'")
    expect(postBody).toContain('count(*) FROM supabase_migrations.schema_migrations) <> 51')
  })

  it('treats CRLF and LF packet copies as equivalent only after normalization', () => {
    const bodyPattern = new RegExp(migration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    const crlfPacket = packet.replace(/\n/g, '\r\n')
    expect(crlfPacket.match(bodyPattern) ?? []).toHaveLength(0)
    expect(normalizeLineEndings(crlfPacket).match(bodyPattern)).toHaveLength(2)
  })

  it('has exactly one expected-history insert and rejects duplicate VALUES tokens', () => {
    expect(packet.match(/INSERT INTO opt6_history_expected/g)).toHaveLength(1)
    const insert = packet.slice(packet.indexOf('INSERT INTO opt6_history_expected'), packet.indexOf(';', packet.indexOf('INSERT INTO opt6_history_expected')))
    expect(insert.match(/\bVALUES\b/g)).toHaveLength(1)
    expect(packet).not.toMatch(/INSERT INTO opt6_history_expected[\s\S]{0,200}\bVALUES\s+VALUES\b/)
  })

  it('passes the deterministic structural SQL sanity check', () => {
    let depth = 0
    for (const character of packet) {
      if (character === '(') depth += 1
      if (character === ')') depth -= 1
      expect(depth).toBeGreaterThanOrEqual(0)
    }
    expect(depth).toBe(0)
    expect(packet.match(/^BEGIN;$/gm)).toHaveLength(1)
    expect(packet.match(/^COMMIT;$/gm)).toHaveLength(1)
    expect(packet.match(/\$migration\$/g)).toHaveLength(2)
  })

  it('keeps both pre- and post-body exact history guards tied to the active-sync gate', () => {
    expect(packet.match(/FULL JOIN actual_history AS actual USING \(version\)/g)).toHaveLength(2)
    expect(packet.match(/status = 'in_progress'/g)).toHaveLength(2)
    expect(packet.indexOf('LOCK TABLE supabase_migrations.schema_migrations')).toBeLessThan(packet.indexOf('-- Migration 00051:'))
  })
})
