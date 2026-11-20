import 'server-only'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

/**
 * 관리자 확인 — 인센티브 정산처럼 관리자 한 사람만 보는 화면과 API에 쓴다.
 *
 * 로그인 세션을 Supabase Auth에 다시 확인(getUser)한 뒤 DB의 is_app_admin()에 묻는다.
 * 관리자 명단(app_admins)은 RLS로 막혀 있어 로그인한 사람도 직접 읽거나 고칠 수 없고,
 * 관리자 표들도 같은 함수로 RLS가 걸려 있어 이 검사를 빠뜨려도 DB가 한 번 더 막는다.
 * 마이그레이션 전이거나 확인이 실패하면 관리자가 아닌 것으로 본다.
 */
export const getAdmin = cache(async () => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data, error } = await supabase.rpc('is_app_admin')
  if (error || data !== true) return null
  return { supabase, user }
})

export type Admin = NonNullable<Awaited<ReturnType<typeof getAdmin>>>

/** API 라우트용 — 관리자가 아니면 404. 이런 기능이 있다는 것도 드러내지 않는다 */
export async function requireAdminApi(): Promise<Admin | Response> {
  const admin = await getAdmin()
  if (!admin) return Response.json({ error: '찾을 수 없습니다.' }, { status: 404 })
  return admin
}
