import { createClient } from '@/lib/supabase/server'
import { createGongguClient } from '@/lib/supabase/gonggu'
import { NextResponse } from 'next/server'

// 공구 취급액을 캠페인 관리 시스템으로 동기화.
// 취급액(gross_sales)만 전송한다 — 마진은 직원용 시스템에 노출하지 않는다.
export async function POST(request: Request) {
  const { campaignId, year, month } = await request.json()
  if (!campaignId || !year || !month) {
    return NextResponse.json({ error: 'campaignId, year, month 필수' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 })

  const gonggu = createGongguClient()
  if (!gonggu) {
    return NextResponse.json(
      { error: '공구 시스템 연동 키가 설정되지 않았습니다. 저장은 완료되었으나 관리 시스템에는 반영되지 않았습니다.' },
      { status: 503 }
    )
  }

  const { data: row, error: readError } = await supabase
    .from('gonggu_sales')
    .select('gross_sales')
    .eq('campaign_id', campaignId)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle()

  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 })

  if (row) {
    const { error } = await gonggu.from('campaign_finance').upsert(
      {
        campaign_id: campaignId,
        year,
        month,
        confirmed_sales: row.gross_sales,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'campaign_id,year,month' }
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    // 재무 쪽 기록이 삭제된 경우 관리 시스템에서도 제거
    const { error } = await gonggu
      .from('campaign_finance')
      .delete()
      .eq('campaign_id', campaignId)
      .eq('year', year)
      .eq('month', month)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
