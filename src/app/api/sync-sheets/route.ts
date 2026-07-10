import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import {
  fetchSheetRows, writeBackSyncIds, makeSyncId, makeLegacyExternalId, type SheetRow,
} from '@/lib/google-sheets'
import { findSimilar } from '@/lib/utils/levenshtein'
import type { Database } from '@/types/database'

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type ExistingPayment = {
  id: string
  external_id: string | null
  payment_date: string
  client_name_raw: string | null
  amount: number
  memo: string | null
  manager: string | null
  status: 'confirmed' | 'balance_due' | 'unpaid'
  source: string
}

const toDbStatus = (s: SheetRow['status']): 'confirmed' | 'balance_due' | 'unpaid' =>
  s === '잔금처리요망' ? 'balance_due' : s === '미입금' ? 'unpaid' : 'confirmed'

/** 시트 행 → DB 메모 (상태 태그 없이 순수 메모만) */
const buildMemo = (row: SheetRow): string | null => {
  const parts = [
    row.memo,
    row.representative ? `대표: ${row.representative}` : '',
    row.phone ? `연락처: ${row.phone}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' | ') : null
}

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

  const trigger = hasCronAuth ? 'cron' : 'manual'
  let fromDate = '2026-04-01'

  try {
    try {
      const body = await request.json()
      if (body?.fromDate) fromDate = body.fromDate
    } catch { /* body 없으면 기본값 사용 */ }

    const rows = await fetchSheetRows(fromDate)
    if (rows.length === 0) {
      await logSync({ trigger, fromDate })
      return Response.json({ synced: 0, updated: 0, skipped: 0, unmatched: 0, pending: 0, created: 0 })
    }

    const { data: existingRaw } = await supabase
      .from('payments')
      .select('id, external_id, payment_date, client_name_raw, amount, memo, manager, status, source')
    const existing = (existingRaw ?? []) as ExistingPayment[]

    // A열 동기화 ID 기준 매칭 (신규 방식 — 내용이 바뀌어도 같은 행으로 인식)
    const byExternalId = new Map<string, ExistingPayment>()
    for (const p of existing) {
      if (p.external_id) byExternalId.set(p.external_id, p)
    }

    // ── 레거시 매칭용 (A열 ID가 아직 없는 기존 데이터) ──────────────
    const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-')
    const normMemo = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, '')
    const legacyList = existing.filter((p) => p.external_id?.startsWith('sheet_'))
    // 날짜+상호명+금액+메모 soft 매칭 — 메모 포함으로 같은 날 동일 금액의 추가·재계약 구분 유지
    const softDupMap = new Map<string, ExistingPayment>()
    for (const p of existing) {
      if (!p.client_name_raw) continue
      const key = `${p.payment_date}|${normName(p.client_name_raw)}|${p.amount}|${normMemo(p.memo)}`
      if (!softDupMap.has(key)) softDupMap.set(key, p)
    }
    // 수기 입력(external_id 없는) 항목 — 메모가 달라도 날짜+상호명+금액이 같으면 같은 건으로 인식
    const manualDupMap = new Map<string, ExistingPayment>()
    for (const p of existing) {
      if (p.external_id || !p.client_name_raw) continue
      const key = `${p.payment_date}|${normName(p.client_name_raw)}|${p.amount}`
      if (!manualDupMap.has(key)) manualDupMap.set(key, p)
    }

    // 클라이언트 목록 (매칭·자동생성용) — 동기화 중 생성된 항목도 누적
    const { data: clients } = await supabase.from('clients').select('id, name')
    const clientList: { id: string; name: string }[] = (clients ?? []).map((c) => ({ id: c.id, name: c.name }))

    let synced = 0
    let updated = 0       // 시트 수정이 기존 건에 반영됨
    let skipped = 0       // 변경 없음
    let unmatched = 0     // 클라이언트명 없어서 미매칭
    let pending = 0       // 잔금/미입금
    let created = 0       // 자동 생성된 프로젝트 수
    const errors: { row: number; reason: string }[] = []
    const writeBacks: { rowIndex: number; syncId: string }[] = []

    for (const row of rows) {
      const dbStatus = toDbStatus(row.status)
      const dbMemo = buildMemo(row)

      // ── 1) A열 동기화 ID로 기존 건 매칭 ─────────────────────────
      if (row.syncId) {
        const found = byExternalId.get(row.syncId)
        if (found) {
          if (found.status !== 'confirmed') {
            // 미확정(수금 예정) 건 — 시트가 원본이므로 수정 사항을 그대로 반영
            const changed =
              found.client_name_raw !== (row.clientName || null) ||
              found.amount !== row.amount ||
              found.payment_date !== row.date ||
              found.manager !== (row.manager || null) ||
              found.memo !== dbMemo ||
              found.status !== dbStatus
            if (changed) {
              const { error } = await supabase.from('payments').update({
                client_name_raw: row.clientName || null,
                amount: row.amount,
                payment_date: row.date,
                manager: row.manager || null,
                memo: dbMemo,
                status: dbStatus,
              }).eq('id', found.id)
              if (error) errors.push({ row: row.rowIndex, reason: `업데이트 실패: ${error.message}` })
              else updated++
            } else skipped++
          } else {
            // 확정 건 — 금액·날짜는 앱에서 확정한 값을 유지하고 표시 필드만 반영
            const changed =
              found.client_name_raw !== (row.clientName || null) ||
              found.manager !== (row.manager || null)
            if (changed) {
              const { error } = await supabase.from('payments').update({
                client_name_raw: row.clientName || null,
                manager: row.manager || null,
              }).eq('id', found.id)
              if (error) errors.push({ row: row.rowIndex, reason: `업데이트 실패: ${error.message}` })
              else updated++
            } else skipped++
          }
        } else {
          // ID는 있는데 DB에 없음 → 앱에서 삭제된 건. 재생성하지 않는다.
          skipped++
        }
        continue
      }

      // ── 2) A열 ID가 없는 행 — 레거시 방식으로 기존 건 탐색 ───────
      const legacyId = makeLegacyExternalId(row)
      const baseKeyNoMemo = row.clientName
        ? `sheet_${row.date}_${normName(row.clientName)}_${row.amount}`
        : null
      const baseKeyWithMemo = baseKeyNoMemo ? `${baseKeyNoMemo}_${normName(row.memo)}` : null
      const legacyMatch =
        byExternalId.get(legacyId) ??
        (baseKeyNoMemo
          ? legacyList.find((p) =>
              p.external_id === baseKeyNoMemo ||
              p.external_id === baseKeyWithMemo ||
              (baseKeyWithMemo && p.external_id!.startsWith(`${baseKeyWithMemo}_`)))
          : undefined) ??
        (row.clientName
          ? softDupMap.get(`${row.date}|${normName(row.clientName)}|${row.amount}|${normMemo(buildMemo(row))}`)
          : undefined) ??
        (row.clientName
          ? manualDupMap.get(`${row.date}|${normName(row.clientName)}|${row.amount}`)
          : undefined)

      const newSyncId = makeSyncId()

      if (legacyMatch) {
        // 기존 건에 새 동기화 ID를 부여하고 시트에도 기록 — 다음부터는 내용이 바뀌어도 중복되지 않는다
        // (ID 셀에 다른 내용이 있으면 기록하지 않고 매번 레거시 매칭으로 처리)
        if (!row.idCellOccupied) {
          const { error } = await supabase.from('payments')
            .update({ external_id: newSyncId }).eq('id', legacyMatch.id)
          if (!error) {
            byExternalId.set(newSyncId, { ...legacyMatch, external_id: newSyncId })
            writeBacks.push({ rowIndex: row.rowIndex, syncId: newSyncId })
          }
        }
        skipped++
        continue
      }

      // ── 3) 신규 행 — 결제 생성 ──────────────────────────────────
      const isPending = dbStatus !== 'confirmed'

      let projectId: string | null = null
      let matched = false

      if (row.clientName) {
        // 클라이언트 찾기 (없으면 자동 생성)
        let clientId: string | null = null
        const exactClient = clientList.find(
          (c) => c.name.toLowerCase() === row.clientName.toLowerCase()
        )

        if (exactClient) {
          clientId = exactClient.id
        } else {
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

        // 프로젝트 찾기 / 생성
        //    연결 우선순위: 잔여 결제가 남은 진행중 → 잔여 있는 완료(잔금)
        //    완납된 프로젝트엔 합치지 않는다 — 같은 클라이언트라도 별개 계약으로 보고 새로 생성
        if (clientId) {
          const { data: clientProjects } = await supabase
            .from('projects')
            .select('id, status, total_amount')
            .eq('client_id', clientId)
            .neq('status', 'cancelled')
            .order('created_at', { ascending: false })

          const projs = clientProjects ?? []

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

          // '추가계약' 상태이거나 특이사항에 재계약·추가계약 표기가 있으면 새 프로젝트로 분리
          const memoRenewal = /재\s*계약|추가\s*계약/.test(row.memo)
          const forceNewProject = row.status === '추가계약' || memoRenewal
          const target = forceNewProject
            ? null
            : (ongoingWithBalance[0] ?? completedWithBalance[0] ?? null)

          if (target) {
            projectId = target.id
            matched = true
            // 누적 결제가 기존 계약금액을 넘으면 총액 상향 (분할 납부·추가 결제 반영)
            const newPaidTotal = (paidByProject[target.id] ?? 0) + row.amount
            if (newPaidTotal > target.total_amount) {
              await supabase.from('projects').update({ total_amount: newPaidTotal }).eq('id', target.id)
            }
          } else {
            const priorCount = projs.length
            const isRenewal = priorCount > 0
            const forceTag = /재\s*계약/.test(row.memo) ? '재계약' : '추가계약'
            const projectName = forceNewProject && isRenewal
              ? `${row.clientName} (${forceTag} ${priorCount}차)`
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
            }
          }
        }
      }

      if (!matched) unmatched++
      if (isPending) pending++

      const paymentType =
        row.status === '잔금처리요망' ? '잔금' :
        row.status === '미입금' ? '기타' : null

      const { error: insertErr } = await supabase.from('payments').insert({
        project_id: projectId,
        amount: row.amount,
        payment_date: row.date,
        payment_type: paymentType,
        manager: row.manager || null,
        memo: dbMemo,
        source: 'slack',
        external_id: newSyncId,
        client_name_raw: row.clientName || null,
        matched,
        status: dbStatus,
      })

      if (insertErr) {
        errors.push({ row: row.rowIndex, reason: `결제 저장 실패: ${insertErr.message}` })
      } else {
        synced++
        if (!row.idCellOccupied) writeBacks.push({ rowIndex: row.rowIndex, syncId: newSyncId })
        if (row.clientName) {
          softDupMap.set(`${row.date}|${normName(row.clientName)}|${row.amount}|${normMemo(dbMemo)}`, {
            id: '', external_id: newSyncId, payment_date: row.date,
            client_name_raw: row.clientName, amount: row.amount,
            memo: dbMemo, manager: row.manager || null, status: dbStatus, source: 'slack',
          })
        }
      }
    }

    // 시트 A열에 동기화 ID 기록 — 실패해도 동기화 자체는 성공 처리 (다음 실행에서 레거시 매칭으로 복구됨)
    let writeBackError: string | null = null
    try {
      await writeBackSyncIds(writeBacks)
    } catch (e) {
      writeBackError = e instanceof Error ? e.message : '시트 ID 기록 실패'
    }

    await logSync({ trigger, fromDate, synced, updated, skipped, created, pending, unmatched })

    return Response.json({
      synced,
      updated,
      skipped,
      unmatched,
      pending,
      created,
      errors: errors.length > 0 ? errors : undefined,
      writeBackError: writeBackError ?? undefined,
      total: rows.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류'
    await logSync({ trigger, fromDate, error: message })
    return Response.json({ error: message }, { status: 500 })
  }
}

async function logSync(log: {
  trigger: string; fromDate: string
  synced?: number; updated?: number; skipped?: number
  created?: number; pending?: number; unmatched?: number; error?: string
}) {
  try {
    await supabase.from('sync_logs').insert({
      trigger: log.trigger,
      from_date: log.fromDate,
      synced: log.synced ?? 0,
      updated: log.updated ?? 0,
      skipped: log.skipped ?? 0,
      created_projects: log.created ?? 0,
      pending: log.pending ?? 0,
      unmatched: log.unmatched ?? 0,
      error: log.error ?? null,
    })
  } catch { /* 로그 실패는 무시 */ }
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
