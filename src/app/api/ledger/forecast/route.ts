/**
 * 현금 흐름 예측 — GET /api/ledger/forecast?months=3
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildForecast } from '@/lib/ledger/forecast'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  const months = Math.min(Math.max(Number(new URL(request.url).searchParams.get('months') ?? 3), 1), 6)
  try {
    return Response.json({ ok: true, forecast: await buildForecast(createAdminClient(), months) })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '알 수 없는 오류' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
