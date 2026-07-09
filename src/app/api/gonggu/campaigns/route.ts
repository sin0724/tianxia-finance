import { createClient } from '@/lib/supabase/server'
import { createGongguClient } from '@/lib/supabase/gonggu'
import { NextResponse } from 'next/server'

// 공구 캠페인 관리 시스템의 캠페인 목록 — 취급액 입력 시 연동 대상 선택용
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 })

  const gonggu = createGongguClient()
  if (!gonggu) {
    return NextResponse.json(
      { error: '공구 시스템 연동 키가 설정되지 않았습니다. .env.local의 GONGGU_SUPABASE_URL / GONGGU_SUPABASE_SERVICE_ROLE_KEY를 확인해주세요.' },
      { status: 503 }
    )
  }

  const { data, error } = await gonggu
    .from('campaigns')
    .select('id, client_name, campaign_name, start_date, end_date')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ campaigns: data ?? [] })
}
