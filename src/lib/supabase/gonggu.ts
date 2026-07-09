import { createClient } from '@supabase/supabase-js'

// 공구 캠페인 관리 시스템(gonggu-admin)의 Supabase — 별도 프로젝트.
// service role 키는 서버에서만 사용하며, 취급액 동기화(campaign_finance 쓰기)와
// 캠페인 목록 조회에만 쓴다. 마진 데이터는 절대 이 DB로 보내지 않는다.
export function createGongguClient() {
  const url = process.env.GONGGU_SUPABASE_URL
  const key = process.env.GONGGU_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
