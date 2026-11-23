import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { findSimilar } from '@/lib/utils/levenshtein'
import { runSheetSyncLocked, isSyncFailure, isSyncSkipped } from '@/lib/sheets-sync'
import { isCronOrSessionAuthorized } from '@/lib/auth/cron-or-session'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/types/database'

/**
 * 결제시트 → DB 동기화. 동기화 본체는 src/lib/sheets-sync.ts 에 있고,
 * 앱이 15분마다 자동으로도 돌린다 (src/instrumentation.ts). 여기서는 인증만 처리한다.
 */
export async function POST(request: Request) {
  const auth = await isCronOrSessionAuthorized(request)
  if (!auth.ok) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const trigger = auth.via === 'cron' ? 'cron' : 'manual'
  let fromDate: string | undefined
  try {
    const body = await request.json()
    if (body?.fromDate) fromDate = body.fromDate
  } catch { /* body 없으면 기본값 사용 */ }

  // 자동 동기화와 겹치면 실행하지 않는다 — 같은 행을 두 번 넣는 일을 막기 위해
  const result = await runSheetSyncLocked({ trigger, fromDate })
  if (isSyncSkipped(result)) {
    return Response.json({ error: '이미 동기화가 진행 중입니다. 잠시 후 다시 시도해주세요.', skipped: result.skipped }, { status: 409 })
  }
  if (isSyncFailure(result)) {
    return Response.json({ error: result.error }, { status: 500 })
  }
  return Response.json(result)
}

/** 유사 클라이언트 제안 (미매칭 결제의 상호명 기반) — 세션 인증 필요 */
export async function GET(request: Request) {
  const cookieStore = await cookies()
  const sessionClient = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )
  const { data: { user } } = await sessionClient.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')

  if (!query) {
    return Response.json({ error: 'q 파라미터 필요' }, { status: 400 })
  }

  const { data: clients } = await createAdminClient().from('clients').select('id, name')
  const suggestions = findSimilar(
    query,
    (clients ?? []).map((c) => ({ id: c.id, name: c.name })),
    5,
    0.3,
  )

  return Response.json({ suggestions })
}
