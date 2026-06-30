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

    // 기존 결제 조회 — external_id 중복 방지 + 날짜·상호명·금액·메모 soft 중복 방지 (수기 입력 포함)
    const { data: existingPayments } = await supabase
      .from('payments')
      .select('external_id, payment_date, client_name_raw, amount, memo')

    const existingIds = new Set(
      (existingPayments ?? []).filter((p) => p.external_id).map((p) => p.external_id)
    )
    // external_id 접두어(날짜+상호명+금액) 목록 — 메모·담당자가 수정돼도 같은 시트 행임을 인식
    // 앱에서 입금 확정 시 payment_date·금액·메모가 바뀌어 softKey 매칭이 깨지는 경우를 보완
    const existingExternalIds = (existingPayments ?? [])
      .map((p) => p.external_id)
      .filter((id): id is string => !!id)
    // 날짜+상호명+금액+메모 기준 soft 중복 방지 — 메모 포함으로 재계약·추가계약 구분 가능
    const softDupSet = new Set(
      (existingPayments ?? [])
        .filter((p) => p.client_name_raw)
        .map((p) => {
          const memoClean = (p.memo ?? '').toLowerCase().replace(/\s+/g, '')
          return `${p.payment_date}|${(p.client_name_raw ?? '').toLowerCase().replace(/\s+/g, '')}|${p.amount}|${memoClean}`
        })
    )
    // 수기 입력(수금예정 추가 등 external_id 없는) 항목과 시트 행이 겹칠 때 중복 방지.
    // 메모를 뺀 날짜+상호명+금액으로 매칭 — 수기 메모와 시트 메모가 달라도 같은 건으로 인식.
    // external_id 있는 항목은 제외하므로 시트끼리의 재계약·추가계약 구분에는 영향 없음.
    const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-')
    const manualDupSet = new Set(
      (existingPayments ?? [])
        .filter((p) => !p.external_id && p.client_name_raw)
        .map((p) => `${p.payment_date}|${normName(p.client_name_raw ?? '')}|${p.amount}`)
    )

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
    const errors: { row: number; reason: string }[] = []

    for (const row of rows) {
      const externalId = makeExternalId(row)

      // DB에 저장될 메모와 동일한 형식으로 softKey 구성 (statusTag + memo + 대표자 + 연락처)
      const statusTagForKey =
        row.status === '잔금처리요망' ? '⚠ 잔금 처리 요망' :
        row.status === '미입금' ? '🔴 미입금' : ''
      const dbMemoForKey = [
        statusTagForKey,
        row.memo,
        row.representative ? `대표: ${row.representative}` : '',
        row.phone ? `연락처: ${row.phone}` : '',
      ].filter(Boolean).join(' | ').toLowerCase().replace(/\s+/g, '')

      const softKey = row.clientName
        ? `${row.date}|${row.clientName.toLowerCase().replace(/\s+/g, '')}|${row.amount}|${dbMemoForKey}`
        : null

      // external_id 접두어 매칭 — 같은 시트 행이 재동기화될 때 중복 생성 방지.
      //  - 구버전 external_id(`sheet_날짜_상호_금액`, 접미사 없음)는 정확히 일치할 때만 중복 처리.
      //  - 신버전은 메모까지 같을 때(담당자만 달라도) 같은 행으로 인식해 중복 생성을 막는다.
      //  - 메모가 다르면 같은 날·같은 금액이라도 별개의 추가·재계약으로 보고 통과시킨다.
      //    (과거에는 날짜+상호+금액만 비교해 같은 날 동일 금액의 추가계약이 누락되던 버그를 수정)
      const baseKeyNoMemo = row.clientName
        ? `sheet_${row.date}_${normName(row.clientName)}_${row.amount}`
        : null
      const baseKeyWithMemo = baseKeyNoMemo ? `${baseKeyNoMemo}_${normName(row.memo)}` : null
      const baseDup = !!baseKeyNoMemo && existingExternalIds.some(
        (id) =>
          id === baseKeyNoMemo ||                  // 구버전(접미사 없음) 정확 일치
          id === baseKeyWithMemo ||                // 메모까지 동일
          id.startsWith(`${baseKeyWithMemo}_`)     // 메모 동일 + 담당자만 다름
      )

      // 수기 입력 항목과의 중복 — 날짜+상호명+금액으로 매칭
      const manualKey = row.clientName ? `${row.date}|${normName(row.clientName)}|${row.amount}` : null
      const manualDup = !!manualKey && manualDupSet.has(manualKey)

      if (existingIds.has(externalId) || (softKey && softDupSet.has(softKey)) || baseDup || manualDup) {
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
          const { data: newClient, error: clientErr } = await supabase
            .from('clients')
            .insert({
              name: row.clientName,
              manager: row.representative || null,
              contact: row.phone || null,
            })
            .select('id')
            .single()
          if (clientErr) {
            errors.push({ row: row.rowIndex, reason: `클라이언트 생성 실패: ${clientErr.message}` })
          } else if (newClient) {
            clientId = newClient.id
            clientList.push({ id: newClient.id, name: row.clientName })
          }
        }

        // 2. 프로젝트 찾기 / 생성
        //    연결 우선순위: 잔여 결제가 남은 진행중 → 잔여 있는 완료(잔금)
        //    완납된 진행중 프로젝트엔 합치지 않는다 — 같은 클라이언트라도 별개 계약으로 보고
        //    새 프로젝트를 자동 생성한다 (분할납부는 '잔금처리요망' 상태로 들어와 잔여가 남으므로 위에서 매칭됨)
        if (clientId) {
          const { data: clientProjects } = await supabase
            .from('projects')
            .select('id, status, total_amount')
            .eq('client_id', clientId)
            .neq('status', 'cancelled')
            .order('created_at', { ascending: false })

          const projs = clientProjects ?? []

          // 프로젝트별 입금 합계 (총액 갱신·잔여 판단용)
          const paidByProject: Record<string, number> = {}
          if (projs.length > 0) {
            const { data: projPays } = await supabase
              .from('payments')
              .select('project_id, amount')
              .in('project_id', projs.map((p) => p.id))
            for (const pay of projPays ?? []) {
              if (pay.project_id) {
                paidByProject[pay.project_id] = (paidByProject[pay.project_id] ?? 0) + pay.amount
              }
            }
          }

          const ongoing = projs.filter((p) => p.status === 'ongoing')
          const ongoingWithBalance = ongoing.filter((p) => (paidByProject[p.id] ?? 0) < p.total_amount)
          const completedWithBalance = projs.filter(
            (p) => p.status === 'completed' && (paidByProject[p.id] ?? 0) < p.total_amount
          )

          // '추가계약' 상태면 진행 중인 프로젝트가 있어도 새 프로젝트로 분리
          //  → 당월 매출과 실행비를 같은 달에 매칭 (이익 과대계상 방지)
          const forceNewProject = row.status === '추가계약'
          // 완납된 ongoing 프로젝트는 폴백 대상에서 제외 — 잔여가 남은 건에만 합친다
          const target = forceNewProject
            ? null
            : (ongoingWithBalance[0] ?? completedWithBalance[0] ?? null)

          if (target) {
            // 기존 프로젝트에 결제 연결
            projectId = target.id
            matched = true
            // 누적 결제가 기존 계약금액을 넘으면 총액 상향 (분할 납부·추가 결제 반영)
            const newPaidTotal = (paidByProject[target.id] ?? 0) + row.amount
            if (newPaidTotal > target.total_amount) {
              await supabase.from('projects').update({ total_amount: newPaidTotal }).eq('id', target.id)
            }
          } else {
            // 연결 가능한 프로젝트 없음 → 신규·재계약으로 판단해 프로젝트 자동 생성
            const priorCount = projs.length            // 기존(비취소) 계약 수
            const isRenewal = priorCount > 0
            const projectName = forceNewProject
              ? `${row.clientName} (추가계약 ${priorCount}차)`
              : isRenewal
                ? `${row.clientName} (재계약 ${priorCount}차)`
                : row.clientName

            const { data: newProject, error: projErr } = await supabase
              .from('projects')
              .insert({
                client_id: clientId,
                name: projectName,
                total_amount: row.amount,
                contract_date: row.date,
                status: 'ongoing',
                memo: forceNewProject ? '추가/재계약 (자동 생성)' : isRenewal ? '재계약 (자동 생성)' : null,
              })
              .select('id')
              .single()
            if (projErr) {
              errors.push({ row: row.rowIndex, reason: `프로젝트 생성 실패: ${projErr.message}` })
            } else if (newProject) {
              projectId = newProject.id
              matched = true
              created++
              // 재계약이면 직전 프로젝트의 구성 상품(실행비)을 복제해 실행비 누락 방지
              if (isRenewal) {
                const { data: prevItems } = await supabase
                  .from('project_items')
                  .select('product_id, item_name, quantity, unit_price_snapshot, unit_cost_snapshot')
                  .eq('project_id', projs[0].id)
                if (prevItems && prevItems.length > 0) {
                  await supabase.from('project_items').insert(
                    prevItems.map((it) => ({ ...it, project_id: newProject.id }))
                  )
                }
              }
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

      const { error: insertErr } = await supabase.from('payments').insert({
        project_id: projectId,
        amount: row.amount,
        payment_date: row.date,
        payment_type: paymentType,
        manager: row.manager || null,
        memo: memoParts.length ? memoParts.join(' | ') : null,
        source: 'slack',
        external_id: externalId,
        client_name_raw: row.clientName || null,
        matched,
      })

      if (insertErr) {
        errors.push({ row: row.rowIndex, reason: `결제 저장 실패: ${insertErr.message}` })
        // 중복 키 에러는 이미 DB에 있는 것으로 처리 (외부 id 중복)
        if (!insertErr.message.includes('duplicate') && !insertErr.message.includes('unique')) {
          unmatched = Math.max(0, unmatched - (matched ? 0 : 1))
        }
      } else {
        synced++
        // 새로 추가된 항목을 중복 검사 집합에 반영해 루프 내 중복 방지
        if (softKey) softDupSet.add(softKey)
        existingIds.add(externalId)
        existingExternalIds.push(externalId)
      }
    }

    return Response.json({
      synced,
      skipped,
      unmatched,
      pending,
      created,
      errors: errors.length > 0 ? errors : undefined,
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
