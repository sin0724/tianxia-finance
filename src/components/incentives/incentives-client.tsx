'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Lock, LockOpen, RefreshCw, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'
import { toast } from '@/lib/toast'
import { formatRate, monthConfig, parseRate, percentInput, summarize, type MonthSummary } from '@/lib/incentives/engine'
import type { CrmResponse, ViewResponse } from '@/lib/incentives/types'
import type { IncentiveClawback, IncentiveLine, IncentiveManager, IncentiveMonth } from '@/types/database'
import { call, errorText, MoneyCell, TextCell, won } from './cells'
import { LineTable, type LinePatch } from './line-table'
import { ClawbackTable, type ClawbackPatch } from './clawback-table'
import { SettingsDialog } from './settings-dialog'
import { Checklist } from './checklist'

/** 인센티브 정산 — 관리자 전용 화면 (페이지에서 관리자를 확인한 뒤에만 그린다) */
export function IncentivesClient() {
  const { year, month } = useMonth()
  // 달을 바꾸면 화면 상태를 처음부터 다시 시작한다
  return <MonthScreen key={`${year}-${month}`} year={year} month={month} />
}

type SummaryKey = keyof Omit<MonthSummary, 'errors'>
const SUMMARY_COLS: { key: SummaryKey; label: string }[] = [
  { key: 'totalSales', label: 'H 총 매출' },
  { key: 'baseSalary', label: 'I 기본급' },
  { key: 'incentive', label: 'J 인센티브' },
  { key: 'special', label: 'K 특별수당' },
  { key: 'gross', label: 'M 세전 급여' },
  { key: 'clawback', label: 'O 환수' },
  { key: 'net', label: 'N 차감액 포함' },
]

function snapshotOf(m: IncentiveMonth): MonthSummary | null {
  const s = m.snapshot as Partial<MonthSummary> | null
  if (!s || typeof s !== 'object' || typeof s.net !== 'number') return null
  return {
    totalSales: Number(s.totalSales ?? 0), baseSalary: Number(s.baseSalary ?? 0), incentive: Number(s.incentive ?? 0),
    special: Number(s.special ?? 0), gross: Number(s.gross ?? 0), clawback: Number(s.clawback ?? 0), net: Number(s.net), errors: 0,
  }
}
const sameSummary = (a: MonthSummary, b: MonthSummary) => SUMMARY_COLS.every(({ key }) => a[key] === b[key])

function MonthScreen({ year, month }: { year: number; month: number }) {
  const viewUrl = `/api/incentives?year=${year}&month=${month}`
  const crmUrl = `/api/incentives/crm?year=${year}&month=${month}`
  const [data, setData] = useState<ViewResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [crm, setCrm] = useState<CrmResponse | null>(null)
  const [crmLoading, setCrmLoading] = useState(true)
  const [tab, setTab] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'sync' | 'create' | 'close'>(null)
  const [syncLog, setSyncLog] = useState<string[] | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const viewSeq = useRef(0)
  const crmSeq = useRef(0)

  /** withFinance=false: 칸만 고쳤을 때 — 재무관리 대조는 줄이 늘거나 줄 때만 다시 읽는다 */
  const reload = useCallback(async (withFinance = true) => {
    const my = ++viewSeq.current
    try {
      const res = await call<ViewResponse>('GET', withFinance ? viewUrl : `${viewUrl}&finance=0`)
      if (my !== viewSeq.current) return
      setData((d) => (withFinance || !d ? res : { ...res, finance: d.finance, financeError: d.financeError }))
      setLoadError(null)
    } catch (e) {
      if (my === viewSeq.current) setLoadError(errorText(e))
    }
  }, [viewUrl])

  const reloadCrm = useCallback(async () => {
    const my = ++crmSeq.current
    try {
      const res = await call<CrmResponse>('GET', crmUrl)
      if (my === crmSeq.current) setCrm(res)
    } catch (e) {
      if (my === crmSeq.current) setCrm({ crm: null, crmError: errorText(e) })
    } finally {
      if (my === crmSeq.current) setCrmLoading(false)
    }
  }, [crmUrl])

  useEffect(() => { reload() }, [reload])
  useEffect(() => { reloadCrm() }, [reloadCrm])

  const view = data?.view ?? null
  const finance = data?.finance ?? null
  const crmView = crm?.crm ?? null

  /** 정산표가 있는 담당자 (설정 순서) */
  const sheets = useMemo(() => {
    if (!view) return []
    return view.managers
      .map((m) => ({ manager: m, month: view.months.find((x) => x.manager_id === m.id) ?? null }))
      .filter((x): x is { manager: IncentiveManager; month: IncentiveMonth } => x.month !== null)
  }, [view])
  const missingSheets = useMemo(
    () => (view ? view.managers.filter((m) => m.active && !view.months.some((x) => x.manager_id === m.id)) : []),
    [view],
  )
  /** 정산시트에서 정산한 달 — 앱 정산표를 만들지 않는다 */
  const sheetMonth = !!view?.sheetUntil && year * 100 + month <= view.sheetUntil.year * 100 + view.sheetUntil.month

  const summaries = useMemo(() => {
    const out: Record<string, { live: MonthSummary; shown: MonthSummary; drift: boolean }> = {}
    if (!view) return out
    for (const { manager, month: m } of sheets) {
      const live = summarize(
        view.lines.filter((l) => l.manager_id === manager.id), m,
        view.clawbacks.filter((c) => c.manager_id === manager.id), monthConfig(view.config, m),
      )
      const snap = m.status === 'closed' ? snapshotOf(m) : null
      out[manager.id] = { live, shown: snap ?? live, drift: !!snap && !sameSummary(snap, live) }
    }
    return out
  }, [view, sheets])

  const activeTab = tab && sheets.some((s) => s.manager.id === tab) ? tab : sheets[0]?.manager.id ?? null

  // ── 쓰기 ───────────────────────────────────────────────────

  function patchLocal(fn: (v: ViewResponse['view']) => ViewResponse['view']) {
    setData((d) => (d ? { ...d, view: fn(d.view) } : d))
  }

  /** 쓰고 나서 서버 값으로 다시 읽는다. cellOnly: 칸만 고친 경우 (재무관리 대조는 그대로) */
  async function run<T>(fn: () => Promise<T>, ok?: string, cellOnly = false): Promise<T | null> {
    try {
      const res = await fn()
      if (ok) toast.success(ok)
      return res
    } catch (e) {
      toast.error(errorText(e))
      return null
    } finally {
      reload(!cellOnly)
    }
  }

  const patchLine = (line: IncentiveLine, patch: LinePatch) => run(async () => {
    const { line: next } = await call<{ line: IncentiveLine }>('PATCH', '/api/incentives/lines', { id: line.id, ...patch })
    patchLocal((v) => ({ ...v, lines: v.lines.map((l) => (l.id === next.id ? next : l)) }))
  }, undefined, true)

  const deleteLine = (line: IncentiveLine) => run(async () => {
    await call('DELETE', '/api/incentives/lines', { id: line.id })
    patchLocal((v) => ({ ...v, lines: v.lines.filter((l) => l.id !== line.id) }))
  }, `${line.client_name} 줄을 지웠습니다.`)

  const addLine = async (managerId: string, fields: { client_name: string; sales: number | null; paid: number | null; rate: string | null; note: string }) =>
    (await run(() => call('POST', '/api/incentives/lines', { manager_id: managerId, year, month, ...fields }))) !== null

  const copyManual = (managerId: string, ids: string[]) => run(async () => {
    const { copied } = await call<{ copied: number }>('POST', '/api/incentives/lines', { copy: { ids, manager_id: managerId, year, month } })
    toast.success(`지난달 수동 줄 ${copied}개를 가져왔습니다. B 매출을 채워 주세요.`)
  })

  const patchMonth = (m: IncentiveMonth, patch: { base_salary?: number; default_rate?: number | null; special_allowance?: number | null; summary_note?: string }) => run(async () => {
    const { month: next } = await call<{ month: IncentiveMonth }>('PATCH', '/api/incentives/months', { id: m.id, ...patch })
    patchLocal((v) => ({ ...v, months: v.months.map((x) => (x.id === next.id ? next : x)) }))
  }, undefined, true)

  async function setClosed(m: IncentiveMonth, name: string, close: boolean) {
    setBusy('close')
    await run(() => call('PATCH', '/api/incentives/months', { id: m.id, action: close ? 'close' : 'reopen' }),
      close ? `${name} ${month}월을 마감했습니다.` : `${name} ${month}월 마감을 취소했습니다.`, true)
    setBusy(null)
  }

  const addClawback = async (managerId: string, fields: { client_name: string; direct_amount: number | null; contract_amount: number | null; progress: number | null; memo: string }) =>
    (await run(() => call('POST', '/api/incentives/clawbacks', { manager_id: managerId, year, month, ...fields }), undefined, true)) !== null

  const patchClawback = (row: IncentiveClawback, patch: ClawbackPatch) => run(async () => {
    const { clawback } = await call<{ clawback: IncentiveClawback }>('PATCH', '/api/incentives/clawbacks', { id: row.id, ...patch })
    patchLocal((v) => ({ ...v, clawbacks: v.clawbacks.map((c) => (c.id === clawback.id ? clawback : c)) }))
  }, undefined, true)

  const deleteClawback = (row: IncentiveClawback) => run(async () => {
    await call('DELETE', '/api/incentives/clawbacks', { id: row.id })
    patchLocal((v) => ({ ...v, clawbacks: v.clawbacks.filter((c) => c.id !== row.id) }))
  }, undefined, true)

  async function sync() {
    setBusy('sync')
    const res = await run(() => call<{ messages: string[] }>('POST', '/api/incentives/sync', { year, month }))
    if (res) { setSyncLog(res.messages); toast.success('CRM 동기화를 마쳤습니다.') }
    setBusy(null)
    reloadCrm()
  }

  /** 설정에 없는 CRM 담당자 값을 담당자에 연결 (새 담당자면 만들고, 이 달 정산표를 갖춘 뒤 동기화) */
  async function assignOwner(body: { owner: string; managerId?: string; newName?: string }) {
    setBusy('sync')
    const res = await run(() => call<{ manager: string; created: string[]; messages: string[]; syncError: string | null }>(
      'POST', '/api/incentives/owners', { year, month, ...body },
    ))
    if (res) {
      setSyncLog(res.messages)
      if (res.syncError) toast.error(`연결했지만 CRM을 읽지 못했습니다: ${res.syncError}`)
      else toast.success(`‘${body.owner}’를 ${res.manager} 정산에 넣고 CRM에서 가져왔습니다.`)
    }
    setBusy(null)
    reloadCrm()
  }

  async function createSheets() {
    setBusy('create')
    const res = await run(() => call<{ created: string[]; messages: string[]; syncError: string | null }>('POST', '/api/incentives/months', { year, month }))
    if (res) {
      setSyncLog(res.messages)
      if (res.syncError) toast.error(`정산표는 만들었지만 CRM을 읽지 못했습니다: ${res.syncError}`)
      else toast.success(res.created.length ? `${res.created.join(', ')} ${month}월 정산표를 만들고 CRM에서 가져왔습니다.` : '이미 정산표가 있습니다.')
    }
    setBusy(null)
    reloadCrm()
  }

  function focusLine(managerId: string, lineId: string) {
    setTab(managerId)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.getElementById(`line-${lineId}`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-blue-400')
      setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400'), 1600)
    }))
  }

  // ── 그리기 ─────────────────────────────────────────────────

  const payMonth = month === 12 ? 1 : month + 1
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 className="text-2xl font-bold">인센티브 정산</h1>
        <p className="mt-0.5 text-xs text-gray-400">{month}월 귀속 · {payMonth}월 지급</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sheets.length > 0 && (
          <Button variant="outline" size="sm" onClick={sync} disabled={busy !== null}>
            <RefreshCw size={14} className={busy === 'sync' ? 'animate-spin' : undefined} />
            {busy === 'sync' ? '동기화 중…' : 'CRM 동기화'}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} disabled={!view}>
          <Settings size={14} /> 설정
        </Button>
        <MonthNavigator />
      </div>
    </div>
  )

  if (!view) {
    return (
      <div className="space-y-4">
        {header}
        <div className="rounded-2xl bg-white p-6 text-sm text-gray-500 ring-1 ring-gray-200/70">
          {loadError ? <span className="text-red-600">불러오지 못했습니다: {loadError}</span> : '불러오는 중…'}
        </div>
      </div>
    )
  }

  const grand = sheets.reduce((t, { manager }) => {
    const s = summaries[manager.id]?.shown
    if (!s) return t
    for (const { key } of SUMMARY_COLS) t[key] += s[key]
    return t
  }, { totalSales: 0, baseSalary: 0, incentive: 0, special: 0, gross: 0, clawback: 0, net: 0 } as Record<SummaryKey, number>)

  return (
    <div className="space-y-4">
      {header}

      {view.managers.length === 0 && (
        <div className="rounded-2xl bg-white p-6 text-sm ring-1 ring-gray-200/70">
          <p className="font-semibold text-gray-900">정산할 담당자가 없습니다.</p>
          <p className="mt-1 text-gray-500">설정에서 담당자와 CRM 담당자명을 먼저 적어 주세요.</p>
          <Button className="mt-3" size="sm" onClick={() => setSettingsOpen(true)}>설정 열기</Button>
        </div>
      )}

      {sheetMonth && sheets.length === 0 && (
        <div className="rounded-2xl bg-white p-5 text-sm ring-1 ring-gray-200/70">
          <p className="font-semibold text-gray-900">{month}월은 정산시트에서 정산한 달입니다.</p>
          <p className="mt-1 text-gray-500">
            앱 정산은 {view.sheetUntil!.month === 12 ? `${view.sheetUntil!.year + 1}년 1월` : `${view.sheetUntil!.month + 1}월`}부터입니다.
            그 전 달의 계약별 정산 누계는 이월 데이터로 들어 있어 잔금 · 분납 계산에 쓰입니다.
          </p>
        </div>
      )}

      {view.managers.length > 0 && missingSheets.length > 0 && !sheetMonth && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-5 text-sm ring-1 ring-gray-200/70">
          <div>
            <p className="font-semibold text-gray-900">
              {sheets.length === 0 ? `${month}월 정산표가 없습니다.` : `${missingSheets.map((m) => m.name).join(', ')} ${month}월 정산표가 없습니다.`}
            </p>
            <p className="mt-1 text-gray-500">
              만들면 담당자마다 정산표가 생기고 CRM 결제시트에서 {month}월 건을 가져옵니다 (정산시트의 &lsquo;새 월 탭 만들기&rsquo;와 같습니다).
            </p>
          </div>
          <Button size="sm" onClick={createSheets} disabled={busy !== null}>
            {busy === 'create' ? '만드는 중…' : `${month}월 정산표 만들기`}
          </Button>
        </div>
      )}

      {syncLog && syncLog.length > 0 && (
        <div className="flex items-start justify-between gap-3 rounded-2xl bg-blue-50 px-5 py-3 text-sm text-blue-900">
          <ul className="space-y-0.5">{syncLog.map((m, i) => <li key={i}>{m}</li>)}</ul>
          <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => setSyncLog(null)}>닫기</button>
        </div>
      )}

      {data?.financeError && (
        <div className="rounded-2xl bg-amber-50 px-5 py-3 text-sm text-amber-800">재무관리 입금 내역을 읽지 못했습니다: {data.financeError}</div>
      )}

      {sheets.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-gray-200/70">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-4 py-2.5 font-medium">담당자</th>
                {SUMMARY_COLS.map((c) => <th key={c.key} className="px-3 py-2.5 text-right font-medium">{c.label}</th>)}
                <th className="px-4 py-2.5 font-medium">상태</th>
              </tr>
            </thead>
            <tbody>
              {sheets.map(({ manager, month: m }) => {
                const s = summaries[manager.id]
                return (
                  <tr key={manager.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-2.5">
                      <button type="button" className="font-semibold text-gray-900 hover:text-blue-600" onClick={() => setTab(manager.id)}>{manager.name}</button>
                    </td>
                    {SUMMARY_COLS.map((c) => (
                      <td key={c.key} className={`px-3 py-2.5 text-right tabular-nums ${c.key === 'net' ? 'font-bold text-gray-900' : 'text-gray-700'}`}>
                        {won(s?.shown[c.key] ?? 0)}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-xs">
                      {m.status === 'closed'
                        ? <span className="inline-flex items-center gap-1 font-semibold text-gray-700"><Lock size={12} /> 마감</span>
                        : <span className="text-gray-500">작성 중</span>}
                      {s?.live.errors ? <span className="ml-2 font-semibold text-red-600">F 오류 {s.live.errors}</span> : null}
                      {s?.drift && (
                        <span className="ml-2 text-amber-700" title={`지금 설정으로 계산하면 N ${won(s.live.net)}`}>마감 뒤 계산 달라짐</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {sheets.length > 1 && (
              <tfoot>
                <tr className="border-t border-gray-100 bg-gray-50/60 font-semibold">
                  <td className="px-4 py-2.5 text-gray-500">합계</td>
                  {SUMMARY_COLS.map((c) => <td key={c.key} className="px-3 py-2.5 text-right tabular-nums">{won(grand[c.key])}</td>)}
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {sheets.length > 0 && (
        <Checklist
          view={view}
          finance={finance}
          crm={crmView}
          crmError={crm?.crmError ?? null}
          crmLoading={crmLoading}
          onFocusLine={focusLine}
          onSync={sync}
          onAssignOwner={assignOwner}
          busy={busy !== null}
        />
      )}

      {sheets.length > 0 && activeTab && (
        <Tabs value={activeTab} onValueChange={(v) => setTab(String(v))}>
          <TabsList>
            {sheets.map(({ manager, month: m }) => (
              <TabsTrigger key={manager.id} value={manager.id}>
                {m.status === 'closed' && <Lock size={12} />}
                {manager.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {sheets.map(({ manager, month: m }) => {
            const locked = m.status === 'closed'
            const lines = view.lines.filter((l) => l.manager_id === manager.id)
            const claws = view.clawbacks.filter((c) => c.manager_id === manager.id)
            const s = summaries[manager.id]
            const have = new Set(lines.map((l) => l.client_name))
            const carry = view.prevManual.filter((l) => l.manager_id === manager.id && !have.has(l.client_name))
            return (
              <TabsContent key={manager.id} value={manager.id} className="mt-3 space-y-4">
                <div className="flex flex-wrap items-start gap-x-6 gap-y-3 rounded-2xl bg-white px-5 py-4 ring-1 ring-gray-200/70">
                  <div className="w-36">
                    <p className="text-xs text-gray-500">I 기본급</p>
                    <MoneyCell label="기본급" value={m.base_salary} allowBlank={false} disabled={locked}
                      className="text-base font-semibold" onSave={(v) => patchMonth(m, { base_salary: v ?? 0 })} />
                  </div>
                  <div className="w-32">
                    <p className="text-xs text-gray-500">기본 인센티브율</p>
                    <TextCell
                      label="기본 인센티브율"
                      value={(m.default_rate ?? null) === null ? '' : formatRate(m.default_rate)}
                      disabled={locked}
                      placeholder={`비우면 설정 ${formatRate(view.config.defaultRate)}`}
                      className="text-base font-semibold"
                      display={(m.default_rate ?? null) === null
                        ? <span className="text-gray-400">설정 {formatRate(view.config.defaultRate)}</span>
                        : <span>{formatRate(m.default_rate)}</span>}
                      onSave={async (v) => {
                        const r = percentInput(v)
                        if (r === undefined) { toast.error('기본율은 0~100 사이 숫자로 적어 주세요 (비우면 설정의 기본 인센티브율).'); return }
                        await patchMonth(m, { default_rate: r })
                      }}
                    />
                  </div>
                  <div className="w-36">
                    <p className="text-xs text-gray-500">K 특별수당</p>
                    <MoneyCell label="특별수당" value={m.special_allowance} disabled={locked} placeholder="없음"
                      className="text-base font-semibold" onSave={(v) => patchMonth(m, { special_allowance: v })} />
                  </div>
                  <div className="min-w-64 flex-1">
                    <p className="text-xs text-gray-500">L 비고</p>
                    <TextCell label="월 비고" multiline value={m.summary_note} disabled={locked} placeholder="메모"
                      onSave={(v) => patchMonth(m, { summary_note: v })} />
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">N 차감액 포함</p>
                    <p className="text-xl font-bold tabular-nums text-gray-900">{won(s?.shown.net ?? 0)}</p>
                    <p className="text-[11px] text-gray-500">
                      M {won(s?.shown.gross ?? 0)} − O {won(s?.shown.clawback ?? 0)}
                    </p>
                  </div>
                  <div className="flex items-center self-center">
                    {locked ? (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setClosed(m, manager.name, false)}>
                        <LockOpen size={14} /> 마감 취소
                      </Button>
                    ) : (
                      <Button size="sm" disabled={busy !== null || !!s?.live.errors} onClick={() => setClosed(m, manager.name, true)}
                        title={s?.live.errors ? 'F칸을 읽을 수 없는 줄이 있어 마감할 수 없습니다.' : undefined}>
                        <Lock size={14} /> {month}월 마감
                      </Button>
                    )}
                  </div>
                </div>

                {locked && (
                  <p className="flex items-center gap-1.5 px-1 text-xs text-gray-500">
                    <CheckCircle2 size={13} className="text-green-600" />
                    {m.closed_at ? `${m.closed_at.slice(0, 10)} 마감` : '마감'} — 고치려면 마감을 취소해 주세요.
                    다음 달 CRM 동기화가 이 달 줄의 비고 · 색은 바꿀 수 있습니다 (정산시트와 같음). 금액은 바뀌지 않습니다.
                  </p>
                )}

                <LineTable
                  lines={lines}
                  config={monthConfig(view.config, m)}
                  locked={locked}
                  finance={finance}
                  crm={crmView}
                  contracts={view.contracts}
                  onPatch={patchLine}
                  onDelete={deleteLine}
                  onAdd={(f) => addLine(manager.id, f)}
                />

                {!locked && carry.length > 0 && (
                  <CarryPanel lines={carry} onCopy={(ids) => copyManual(manager.id, ids)} prevMonth={month === 1 ? 12 : month - 1} />
                )}

                <div className="space-y-2">
                  <p className="px-1 text-sm font-bold text-gray-900">환수내역</p>
                  <ClawbackTable
                    rows={claws}
                    config={view.config}
                    locked={locked}
                    onPatch={patchClawback}
                    onDelete={deleteClawback}
                    onAdd={(f) => addClawback(manager.id, f)}
                  />
                </div>
              </TabsContent>
            )
          })}
        </Tabs>
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        config={view.config}
        managers={view.managers}
        onSaved={() => { reload(); reloadCrm() }}
      />
    </div>
  )
}

/** 지난달 손으로 넣은 줄 (분납 수동 건 등) — 골라서 이 달로 가져온다. B는 0으로 두고 입금 확인 뒤 채운다 */
function CarryPanel({ lines, onCopy, prevMonth }: { lines: IncentiveLine[]; onCopy: (ids: string[]) => Promise<unknown>; prevMonth: number }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(lines.map((l) => l.id)))
  const [saving, setSaving] = useState(false)
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-3 text-sm">
      <p className="font-semibold text-gray-900">{prevMonth}월에 손으로 넣은 줄 {lines.length}개</p>
      <p className="mt-0.5 text-xs text-gray-500">CRM에서 오지 않는 분납 건 등입니다. 가져오면 B 매출 0 · 노란색으로 들어가니 입금을 확인하고 B를 채워 주세요.</p>
      <ul className="mt-2 space-y-1">
        {lines.map((l) => (
          <li key={l.id}>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
              <span>
                <span className="font-medium">{l.client_name}</span>
                <span className="text-gray-500"> · F {l.rate ?? '기본율'}{parseRate(l.rate).kind === 'invalid' ? ' (읽을 수 없음)' : ''}</span>
                {l.note && <span className="block text-xs text-gray-500">{l.note}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Button className="mt-2" size="xs" variant="outline" disabled={saving || picked.size === 0}
        onClick={async () => { setSaving(true); await onCopy([...picked]); setSaving(false) }}>
        고른 {picked.size}개 가져오기
      </Button>
    </div>
  )
}

