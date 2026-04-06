import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { fetchSheetRows, makeExternalId } from '@/lib/google-sheets'
import { findSimilar } from '@/lib/utils/levenshtein'
import type { Database } from '@/types/database'

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // Cron 시크릿으로 인증
  const hasCronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`

  // 또는 로그인된 Supabase 세션으로 인증
  let hasSessionAuth = false
  if (!hasCronAuth) {
    const cookieStore = await cookies()
    const sessionClient = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => cookieStore.getAll() } }
    )
    const { data: { user } } = await sessionClient.auth.getUser()
    hasSessionAuth = !!user
  }

  if (!hasCronAuth && !hasSessionAuth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // 동기화 시작 날짜 (body 또는 기본값)
    let fromDate = '2026-04-01'
    try {
      const body = await request.json()
      if (body?.fromDate) fromDate = body.fromDate
    } catch { /* body 없으면 기본값 사용 */ }

    const rows = await fetchSheetRows(fromDate)
    if (rows.length === 0) {
      return Response.json({ synced: 0, skipped: 0, unmatched: 0, pending: 0, created: 0 })
    }

    // 기존 external_id 목록 조회 (중복 방지)
    const { data: existingPayments } = await supabase
      .from('payments')
      .select('external_id')
      .not('external_id', 'is', null)

    const existingIds = new Set((existingPayments ?? []).map((p) => p.external_id))

    // 클라이언트 목록 (매칭·자동생성용) — 동기화 중 생성된 항목도 누적
    const { data: clients } = await supabase
      .from('clients')
      .select('id, name')

    const clientList: { id: string; name: string }[] = (clients ?? []).map((c) => ({ id: c.id, name: c.name }))

    let synced = 0
    let skipped = 0       // 이미 존재하는 행
    let unmatched = 0     // 클라이언트명 없어서 미매칭
    let pending = 0       // 잔금 처리 요망
    let created = 0       // 자동 생성된 프로젝트 수

    for (const row of rows) {
      const externalId = makeExternalId(row)

      if (existingIds.has(externalId)) {
        skipped++
        continue
      }

      const isPending = row.status === '잔금처리요망' || row.status === '미입금'

      let projectId: string | null = null
      let matched = false

      if (row.clientName) {
        // 1. 클라이언트 찾기 (없으면 자동 생성)
        let clientId: string | null = null
        const exactClient = clientList.find(
          (c) => c.name.toLowerCase() === row.clientName.toLowerCase()
        )

        if (exactClient) {
          clientId = exactClient.id
        } else {
          // 신규 클라이언트 자동 생성
          const { data: newClient } = await supabase
            .from('clients')
            .insert({
              name: row.clientName,
              manager: row.representative || null,
              contact: row.phone || null,
            })
            .select('id')
            .single()
          if (newClient) {
            clientId = newClient.id
            clientList.push({ id: newClient.id, name: row.clientName })
          }
        }

        // 2. 프로젝트 찾기 (없으면 자동 생성)
        if (clientId) {
          // 진행중 프로젝트 우선, 없으면 가장 최근 프로젝트
          const { data: existingProjects } = await supabase
            .from('projects')
            .select('id, status')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(1)

          if (existingProjects && existingProjects.length > 0) {
            projectId = existingProjects[0].id
            matched = true
          } else {
            // 프로젝트 자동 생성
            const { data: newProject } = await supabase
              .from('projects')
              .insert({
                client_id: clientId,
                name: row.clientName,
                total_amount: row.amount,
                contract_date: row.date,
                status: 'ongoing',
              })
              .select('id')
              .single()
            if (newProject) {
              projectId = newProject.id
              matched = true
              created++
            }
          }
        }
      }

      if (!matched) unmatched++
      if (isPending) pending++

      // 메모 구성: 상태 태그 + 특이사항 + 대표자·연락처
      const statusTag =
        row.status === '잔금처리요망' ? '⚠ 잔금 처리 요망' :
        row.status === '미입금' ? '🔴 미입금' : ''

      const memoParts = [
        statusTag,
        row.memo,
        row.representative ? `대표: ${row.representative}` : '',
        row.phone ? `연락처: ${row.phone}` : '',
      ].filter(Boolean)

      const paymentType =
        row.status === '잔금처리요망' ? '잔금' :
        row.status === '미입금' ? '기타' : null

      await supabase.from('payments').insert({
        project_id: projectId,
        amount: row.amount,       // G열 = 총 계약금액 (입금 예정액)
        payment_date: row.date,
        payment_type: paymentType,
        manager: row.manager || null,
        memo: memoParts.length ? memoParts.join(' | ') : null,
        source: 'slack',
        external_id: externalId,
        client_name_raw: row.clientName || null,
        matched,
      })

      synced++
    }

    return Response.json({
      synced,
      skipped,
      unmatched,
      pending,
      created,
      total: rows.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류'
    return Response.json({ error: message }, { status: 500 })
  }
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

  const { data: clients } = await supabase.from('clients').select('id, name')
  const suggestions = findSimilar(
    query,
    (clients ?? []).map((c) => ({ id: c.id, name: c.name })),
    5,
    0.3,
  )

  return Response.json({ suggestions })
}
