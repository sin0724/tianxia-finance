import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'

/**
 * `Authorization: Bearer ${CRON_SECRET}` 또는 로그인된 Supabase 세션이면 통과.
 * cron 으로 통과했는지 알아야 하는 호출자(동기화 trigger 구분)를 위해 방식도 돌려준다.
 */
export async function isCronOrSessionAuthorized(
  request: Request,
): Promise<{ ok: true; via: 'cron' | 'session' } | { ok: false }> {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return { ok: true, via: 'cron' }

  const cookieStore = await cookies()
  const sessionClient = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )
  const { data: { user } } = await sessionClient.auth.getUser()
  return user ? { ok: true, via: 'session' } : { ok: false }
}
