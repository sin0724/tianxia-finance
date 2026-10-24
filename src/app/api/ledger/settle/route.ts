/**
 * 통장 기준 월 정산
 *
 *   GET  /api/ledger/settle?year=&month=[&fx=]   미리보기 + 마감 점검 항목
 *   POST /api/ledger/settle { year, month, fx? }  정산 저장 (monthly_settlements, basis='bank')
 *                                                 fx를 주면 해외 카드 환율 설정도 갱신한다
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeBankSettlement, saveBankSettlement } from '@/lib/ledger/server'

async function authorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`) return true
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return !!user
}

export async function GET(request: Request) {
  if (!(await authorized(request))) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  const { searchParams } = new URL(request.url)
  const year = Number(searchParams.get('year'))
  const month = Number(searchParams.get('month'))
  const fx = searchParams.get('fx') ? Number(searchParams.get('fx')) : undefined
  if (!year || !month) return Response.json({ error: 'year, month 필수' }, { status: 400 })
  try {
    const { result, checks } = await computeBankSettlement(createAdminClient(), year, month, fx)
    return Response.json({ ok: true, result, checks })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '알 수 없는 오류' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!(await authorized(request))) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  const { year, month, fx } = await request.json()
  if (!year || !month) return Response.json({ error: 'year, month 필수' }, { status: 400 })
  try {
    const db = createAdminClient()
    if (fx) {
      await db.from('settings').upsert({ key: 'card_fx_usd_krw', value: Number(fx) }, { onConflict: 'key' })
    }
    const { result, checks } = await computeBankSettlement(db, year, month, fx ? Number(fx) : undefined)
    if (checks.bankRows === 0) return Response.json({ error: '이 달 통장 내역이 없습니다. 먼저 통장 거래내역을 올려 주세요.' }, { status: 400 })
    await saveBankSettlement(db, year, month, result)
    return Response.json({ ok: true, result, checks })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '알 수 없는 오류' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
