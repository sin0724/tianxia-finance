/**
 * 통장·카드 내역 업로드 — 월 마감 화면에서 파일을 올린다.
 *
 *   POST /api/ledger/import   multipart/form-data { kind: 'bank' | 'card', file }
 *
 * 이미 올린 거래는 해시로 걸러지므로 같은 파일·겹치는 기간을 여러 번 올려도 안전하다.
 * 통장은 저장 직후 분류·결제 자동 매칭까지 한다.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseBankCsv, parseCardXls } from '@/lib/ledger/parse'
import { importBank, importCard } from '@/lib/ledger/server'

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const hasCronAuth = !!cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`
  if (!hasCronAuth) {
    // 이 라우트는 미들웨어의 /api 예외 대상이라 여기서 직접 검사한다
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  }

  const form = await request.formData()
  const kind = form.get('kind')
  const file = form.get('file')
  if ((kind !== 'bank' && kind !== 'card') || !(file instanceof File)) {
    return Response.json({ error: 'kind(bank|card)와 file이 필요합니다.' }, { status: 400 })
  }

  try {
    const buf = await file.arrayBuffer()
    const db = createAdminClient()
    if (kind === 'bank') {
      const { rows, errors } = parseBankCsv(buf)
      if (rows.length === 0) return Response.json({ error: '읽을 수 있는 거래가 없습니다.', errors }, { status: 400 })
      const result = await importBank(db, rows, file.name)
      return Response.json({ ok: true, kind, ...result, parseErrors: errors })
    }
    const { rows, errors } = await parseCardXls(buf)
    if (rows.length === 0) return Response.json({ error: '읽을 수 있는 승인 내역이 없습니다.', errors }, { status: 400 })
    const result = await importCard(db, rows, file.name)
    return Response.json({ ok: true, kind, ...result, parseErrors: errors })
  } catch (e) {
    console.error('[ledger/import] 실패:', e)
    return Response.json({ error: e instanceof Error ? e.message : '알 수 없는 오류' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
