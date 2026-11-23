import { getReceivables, groupReceivablesByManager } from '@/lib/payments/receivables'
import { isCronOrSessionAuthorized } from '@/lib/auth/cron-or-session'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * 수금 예정(미수금) 조회 — 결제 내역 → 수금 관리 탭과 같은 기준, 담당자별로 묶어서.
 * 월말 미입금 리포트가 시트를 다시 읽지 않고 이걸 쓴다. 읽기 전용.
 *
 * 인증: `Authorization: Bearer ${CRON_SECRET}` 또는 로그인된 Supabase 세션.
 * 쿼리: ?manager=나병훈 — 담당자 이름(팀 접미사 없이) 하나로 거르기.
 */
export async function GET(request: Request) {
  if (!(await isCronOrSessionAuthorized(request)).ok) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  let rows
  try {
    rows = await getReceivables(db)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  const manager = new URL(request.url).searchParams.get('manager')?.trim()
  if (manager) rows = rows.filter((r) => r.managerName === manager)

  return Response.json({
    asOf: new Date().toISOString(),
    count: rows.length,
    total: rows.reduce((s, r) => s + r.amount, 0),
    byManager: groupReceivablesByManager(rows),
  })
}
