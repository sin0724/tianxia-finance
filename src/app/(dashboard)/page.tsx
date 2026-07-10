'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatKRW } from '@/lib/calculations/settlement'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, ReferenceLine,
} from 'recharts'
import type { MonthlySettlement } from '@/types/database'
import Link from 'next/link'
import { Bell, RefreshCw, X, Calendar, ChevronDown, TrendingUp, TrendingDown } from 'lucide-react'
import { toast } from '@/lib/toast'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'

const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

const CURVE_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
  '#6366f1', '#10b981', '#e11d48', '#0ea5e9',
]

const DISMISSED_PREF_KEY = 'dashboard_dismissed_alerts'

type DashAlert = { id: string; message: string; href: string; level: 'warn' | 'info' }
type PeriodRow = { month: string; 초순: number; 중순: number; 후순: number }

/** 전월 대비 증감 표시 */
function MoMDelta({ current, prev }: { current: number; prev: number | null }) {
  if (prev === null || prev === 0) return null
  const pct = ((current - prev) / Math.abs(prev)) * 100
  if (!isFinite(pct)) return null
  const up = pct >= 0
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? 'text-green-600' : 'text-red-500'}`}>
      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {up ? '+' : ''}{pct.toFixed(1)}% <span className="text-gray-400 font-normal">전월 대비</span>
    </span>
  )
}

export default function DashboardPage() {
  const supabase = createClient()
  const { year: selYear, month: selMonth, isCurrentMonth } = useMonth()

  // ── 데이터 ────────────────────────────────────────────────
  const [initialLoading, setInitialLoading] = useState(true)
  const [settlement, setSettlement]   = useState<MonthlySettlement | null>(null)
  const [prevSettlement, setPrevSettlement] = useState<MonthlySettlement | null>(null)
  const [monthlyData, setMonthlyData] = useState<{ month: string; revenue: number; profit: number }[]>([])
  const [paymentTotal, setPaymentTotal]   = useState(0)
  const [prevPaymentTotal, setPrevPaymentTotal] = useState<number | null>(null)
  const [refundTotal, setRefundTotal]     = useState(0)
  const [pendingTotal, setPendingTotal]   = useState(0)
  const [gongguGross, setGongguGross]     = useState(0)
  const [gongguMargin, setGongguMargin]   = useState(0)
  const [vatRate, setVatRate]             = useState(0.1)
  const [alerts, setAlerts]               = useState<DashAlert[]>([])
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())
  const [permanentDismissed, setPermanentDismissed] = useState<Set<string>>(new Set())
  const [alertsOpen, setAlertsOpen] = useState(true)

  const [periodData, setPeriodData]           = useState<PeriodRow[]>([])
  const [curveData, setCurveData]             = useState<Record<string, number>[]>([])
  const [availableMonths, setAvailableMonths] = useState<number[]>([])
  const [activeCurveMonths, setActiveCurveMonths] = useState<number[]>([])
  const lastCurveYearRef = useRef<number | null>(null)

  // ── 동기화 ────────────────────────────────────────────────
  const [syncing, setSyncing]             = useState(false)
  const [lastSync, setLastSync]           = useState<{ runAt: string; synced: number; updated: number } | null>(null)
  const [syncFrom, setSyncFrom]           = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [showSyncOptions, setShowSyncOptions] = useState(false)

  // 다시 안보기 목록 — app_prefs에 저장되어 PC·모바일 간 공유된다
  useEffect(() => {
    supabase.from('app_prefs').select('value').eq('key', DISMISSED_PREF_KEY).maybeSingle()
      .then(({ data }) => {
        if (Array.isArray(data?.value)) setPermanentDismissed(new Set(data.value as string[]))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { load() }, [selYear, selMonth])  // eslint-disable-line react-hooks/exhaustive-deps

  // 선택 월 변경 시 세션 알림 초기화
  useEffect(() => { setDismissedAlerts(new Set()) }, [selYear, selMonth])

  async function load() {
    const pad = (n: number) => String(n).padStart(2, '0')
    const start = `${selYear}-${pad(selMonth)}-01`
    const lastDay = new Date(selYear, selMonth, 0).getDate()
    const end   = `${selYear}-${pad(selMonth)}-${pad(lastDay)}`

    const prevYear  = selMonth === 1 ? selYear - 1 : selYear
    const prevMonth = selMonth === 1 ? 12 : selMonth - 1
    const prevStart = `${prevYear}-${pad(prevMonth)}-01`
    const prevLastDay = new Date(prevYear, prevMonth, 0).getDate()
    const prevEnd   = `${prevYear}-${pad(prevMonth)}-${pad(prevLastDay)}`

    // 병렬 로드 — 페이지 진입 속도 개선
    const [
      settlementRes, prevSettlementRes, settlementsRes,
      paymentsRes, prevPaymentsRes, pendingRes,
      gongguRes, yearPaymentsRes, settingsRes, syncLogRes,
    ] = await Promise.all([
      supabase.from('monthly_settlements').select('*').eq('year', selYear).eq('month', selMonth).maybeSingle(),
      supabase.from('monthly_settlements').select('*').eq('year', prevYear).eq('month', prevMonth).maybeSingle(),
      supabase.from('monthly_settlements').select('year, month, total_revenue, operating_profit').eq('year', selYear).order('month'),
      supabase.from('payments').select('amount, matched, excluded, status, projects(status)')
        .gte('payment_date', start).lte('payment_date', end),
      supabase.from('payments').select('amount, excluded, projects(status)')
        .eq('status', 'confirmed').gte('payment_date', prevStart).lte('payment_date', prevEnd),
      supabase.from('payments').select('amount, projects(status)').in('status', ['balance_due', 'unpaid']),
      supabase.from('gonggu_sales').select('gross_sales, margin').eq('year', selYear).eq('month', selMonth),
      supabase.from('payments').select('payment_date, amount, status, excluded, projects(status)')
        .gte('payment_date', `${selYear}-01-01`).lte('payment_date', `${selYear}-12-31`),
      supabase.from('settings').select('*').eq('key', 'vat_rate').maybeSingle(),
      supabase.from('sync_logs').select('run_at, synced, updated').order('run_at', { ascending: false }).limit(1).maybeSingle(),
    ])

    const s = settlementRes.data
    setSettlement(s)
    setPrevSettlement(prevSettlementRes.data)

    setMonthlyData((settlementsRes.data ?? []).map((r) => ({
      month: MONTH_LABELS[r.month - 1],
      revenue: r.total_revenue,
      profit: r.operating_profit,
    })))

    // 이번 달 결제 (확정 입금액·미매칭 알림용, 취소 프로젝트 제외)
    type PaymentRow = { amount: number; matched: boolean; excluded: boolean; status: string; projects: { status: string } | null }
    const paymentRows = (paymentsRes.data as unknown as PaymentRow[]) ?? []
    const confirmed = paymentRows.filter(
      (p) => p.status === 'confirmed' && !p.excluded && p.projects?.status !== 'cancelled'
    )
    // 미연결 알림은 확정 입금만 대상 (수금 예정은 수금 관리 탭에서 관리)
    const unmatched = paymentRows.filter((p) => !p.matched && p.status === 'confirmed')
    const refunds = confirmed.filter((p) => p.amount < 0)
    setPaymentTotal(confirmed.reduce((sum, p) => sum + p.amount, 0))
    setRefundTotal(refunds.reduce((sum, p) => sum + p.amount, 0))

    // 전월 입금액 (전월 대비 표시용)
    type PrevRow = { amount: number; excluded: boolean; projects: { status: string } | null }
    const prevRows = (prevPaymentsRes.data as unknown as PrevRow[]) ?? []
    setPrevPaymentTotal(
      prevRows.filter((p) => !p.excluded && p.projects?.status !== 'cancelled')
        .reduce((sum, p) => sum + p.amount, 0)
    )

    // 수금 예정 — 전체 기간 미수금 합산 (취소 프로젝트 제외)
    type PendingRow = { amount: number; projects: { status: string } | null }
    setPendingTotal(((pendingRes.data as unknown as PendingRow[]) ?? [])
      .filter((p) => p.projects?.status !== 'cancelled')
      .reduce((sum, p) => sum + p.amount, 0))

    // 공구 사업부 실적 (선택 월)
    setGongguGross((gongguRes.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0))
    setGongguMargin((gongguRes.data ?? []).reduce((sum, r) => sum + r.margin, 0))

    setVatRate(settingsRes.data ? Number(settingsRes.data.value) : 0.1)

    if (syncLogRes.data) {
      setLastSync({ runAt: syncLogRes.data.run_at, synced: syncLogRes.data.synced, updated: syncLogRes.data.updated })
    }

    // ── 초·중·후순 / 누적 추이 차트 ────────────────────────
    type YrRow = { payment_date: string; amount: number; status: string; excluded: boolean; projects: { status: string } | null }
    const yrFiltered = ((yearPaymentsRes.data as unknown as YrRow[]) ?? [])
      .filter((p) => p.amount > 0)
      .filter((p) => p.status === 'confirmed' && !p.excluded)
      .filter((p) => p.projects?.status !== 'cancelled')

    const periodAgg: Record<number, { 초순: number; 중순: number; 후순: number }> = {}
    for (let m = 1; m <= 12; m++) periodAgg[m] = { 초순: 0, 중순: 0, 후순: 0 }
    for (const p of yrFiltered) {
      const [, mStr, dStr] = p.payment_date.split('-')
      const m = Number(mStr), day = Number(dStr)
      const period = day <= 10 ? '초순' : day <= 20 ? '중순' : '후순'
      periodAgg[m][period] += p.amount
    }
    setPeriodData(Array.from({ length: 12 }, (_, i) => ({
      month: MONTH_LABELS[i],
      초순: periodAgg[i + 1].초순,
      중순: periodAgg[i + 1].중순,
      후순: periodAgg[i + 1].후순,
    })).filter((r) => r.초순 + r.중순 + r.후순 > 0))

    const dailyAgg: Record<number, Record<number, number>> = {}
    for (const p of yrFiltered) {
      const [, mStr, dStr] = p.payment_date.split('-')
      const m = Number(mStr), day = Number(dStr)
      if (!dailyAgg[m]) dailyAgg[m] = {}
      dailyAgg[m][day] = (dailyAgg[m][day] ?? 0) + p.amount
    }
    const yrMonths = Object.keys(dailyAgg).map(Number).sort((a, b) => a - b)
    setAvailableMonths(yrMonths)
    if (lastCurveYearRef.current !== selYear) {
      lastCurveYearRef.current = selYear
      setActiveCurveMonths(yrMonths.slice(-6))
    }
    setCurveData(Array.from({ length: 31 }, (_, i) => {
      const day = i + 1
      const row: Record<string, number> = { day }
      for (const m of yrMonths) {
        const lastD = new Date(selYear, m, 0).getDate()
        if (day > lastD) continue
        let cum = 0
        for (let d = 1; d <= day; d++) cum += dailyAgg[m][d] ?? 0
        row[`${m}월`] = cum
      }
      return row
    }))

    // 알림 (현재 월일 때만) — ID에 연월 포함해 월별 영구 닫기 구분
    const ym = `${selYear}_${selMonth}`
    const newAlerts: DashAlert[] = []
    if (isCurrentMonth) {
      const nowDate = new Date()
      if (nowDate.getDate() >= 25) {
        newAlerts.push({ id: `monthend_${ym}`, level: 'info',
          message: '월말입니다. 지출·급여를 입력하고 정산을 완료해주세요.',
          href: '/reports/monthly' })
      }
      if (unmatched.length > 0) {
        newAlerts.push({ id: 'unmatched', level: 'warn',
          message: `미연결 결제 ${unmatched.length}건 — 프로젝트를 연결해주세요.`,
          href: '/payments' })
      }
      const [expRes, empRes] = await Promise.all([
        supabase.from('monthly_expenses').select('id').eq('year', selYear).eq('month', selMonth).limit(1),
        supabase.from('employees').select('id').eq('active', true).limit(1),
      ])
      if (!expRes.data || expRes.data.length === 0)
        newAlerts.push({ id: `expenses_${ym}`, level: 'info',
          message: `${selMonth}월 지출이 아직 입력되지 않았습니다.`, href: '/expenses' })

      if (empRes.data && empRes.data.length > 0) {
        const { data: pay } = await supabase.from('monthly_payroll').select('id')
          .eq('year', selYear).eq('month', selMonth).limit(1)
        if (!pay || pay.length === 0)
          newAlerts.push({ id: `payroll_${ym}`, level: 'info',
            message: `${selMonth}월 급여가 입력되지 않았습니다.`, href: '/employees' })
      }
      if (!s)
        newAlerts.push({ id: `settlement_${ym}`, level: 'info',
          message: `${selMonth}월 정산이 아직 계산되지 않았습니다.`, href: '/reports/monthly' })
    }
    setAlerts(newAlerts)
    setInitialLoading(false)
  }

  async function handleSync() {
    setSyncing(true)
    setShowSyncOptions(false)
    try {
      const res = await fetch('/api/sync-sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromDate: syncFrom }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const parts = [`${data.synced}건 추가`]
      if (data.updated > 0) parts.push(`${data.updated}건 갱신`)
      parts.push(`${data.skipped}건 변동 없음`)
      if (data.created > 0) parts.push(`프로젝트 ${data.created}개 생성`)
      if (data.pending > 0) parts.push(`⚠ 수금 예정 ${data.pending}건`)
      if (data.unmatched > 0) parts.push(`미매칭 ${data.unmatched}건`)
      toast.success(`동기화 완료: ${parts.join(', ')}`)
      if (data.writeBackError) {
        toast.warning(`시트 ID 기록 실패 — 서비스 계정에 시트 편집 권한을 확인해주세요. (${data.writeBackError})`)
      }
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '동기화 실패')
    } finally {
      setSyncing(false)
    }
  }

  function dismissSession(id: string) {
    setDismissedAlerts((prev) => new Set([...prev, id]))
  }

  function dismissPermanent(id: string) {
    setPermanentDismissed((prev) => {
      const next = new Set([...prev, id])
      supabase.from('app_prefs')
        .upsert({ key: DISMISSED_PREF_KEY, value: [...next], updated_at: new Date().toISOString() }, { onConflict: 'key' })
        .then(({ error }) => { if (error) toast.error('알림 설정 저장 실패: ' + error.message) })
      return next
    })
    setDismissedAlerts((prev) => new Set([...prev, id]))
  }

  function dismissAllSession() {
    setDismissedAlerts((prev) => new Set([...prev, ...alerts.map((a) => a.id)]))
  }

  const visibleAlerts = alerts.filter(
    (a) => !dismissedAlerts.has(a.id) && !permanentDismissed.has(a.id)
  )
  const hasWarnAlert = visibleAlerts.some((a) => a.level === 'warn')

  const supplyValue = settlement?.supply_value ?? paymentTotal / (1 + vatRate)

  function formatSyncTime(iso: string) {
    const d = new Date(iso)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
  }

  return (
    <div className="space-y-6">

      {/* ── 헤더 ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">대시보드</h1>
          <MonthNavigator />
          {!isCurrentMonth && (
            <Badge variant="secondary" className="text-xs">과거 데이터</Badge>
          )}
        </div>

        {/* 동기화 */}
        <div className="flex items-center gap-2 relative self-start sm:self-auto">
          {lastSync && (
            <span className="text-xs text-gray-400">
              마지막 동기화: {formatSyncTime(lastSync.runAt)}
            </span>
          )}
          <div className="relative">
            <div className="flex items-center border rounded-md overflow-hidden">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncing}
                className="rounded-none border-0"
              >
                <RefreshCw size={14} className={`mr-1 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? '동기화 중...' : 'Sheets 동기화'}
              </Button>
              <button
                onClick={() => setShowSyncOptions(!showSyncOptions)}
                className="px-2 py-1.5 border-l text-gray-500 hover:bg-gray-50 text-xs"
                title="동기화 시작 날짜 설정"
              >
                <Calendar size={14} />
              </button>
            </div>
            {showSyncOptions && (
              <div className="absolute right-0 top-full mt-1 z-10 bg-white border rounded-lg shadow-lg p-3 w-64">
                <p className="text-xs text-gray-500 mb-2">이 날짜 이후 데이터를 동기화합니다</p>
                <input
                  type="date"
                  className="w-full border rounded-md px-2 py-1.5 text-sm"
                  value={syncFrom}
                  onChange={(e) => setSyncFrom(e.target.value)}
                />
                <div className="flex gap-1 mt-2">
                  {[
                    { label: '1월~', date: `${selYear}-01-01` },
                    { label: '3월~', date: `${selYear}-03-01` },
                    { label: '이번달~', date: `${selYear}-${String(selMonth).padStart(2,'0')}-01` },
                  ].map(({ label, date }) => (
                    <button
                      key={label}
                      onClick={() => setSyncFrom(date)}
                      className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 알림 */}
      {visibleAlerts.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          {/* 헤더 (접기/펼치기) */}
          <button
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-gray-50 transition-colors"
            onClick={() => setAlertsOpen((v) => !v)}
          >
            <Bell size={14} className={hasWarnAlert ? 'text-orange-500' : 'text-gray-400'} />
            <span className="font-medium text-gray-700">알림 {visibleAlerts.length}개</span>
            {!alertsOpen && (
              <span className="text-gray-400 text-xs truncate flex-1">
                {visibleAlerts.map((a) => a.message).join(' · ')}
              </span>
            )}
            {alertsOpen && (
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); dismissAllSession() }}
                className="ml-auto text-xs text-gray-400 hover:text-gray-600 mr-1"
              >
                모두 닫기
              </span>
            )}
            {!alertsOpen && <span className="flex-1" />}
            <ChevronDown size={14} className={`text-gray-400 transition-transform flex-shrink-0 ${alertsOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* 알림 목록 */}
          {alertsOpen && (
            <div className="border-t divide-y divide-gray-100">
              {visibleAlerts.map((alert) => (
                <div key={alert.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${alert.level === 'warn' ? 'bg-orange-400' : 'bg-blue-400'}`} />
                  <span className="flex-1 text-gray-700">{alert.message}</span>
                  <Link href={alert.href} className="text-blue-500 hover:text-blue-700 text-xs font-medium whitespace-nowrap">
                    바로가기
                  </Link>
                  <button
                    onClick={() => dismissSession(alert.id)}
                    className="text-gray-300 hover:text-gray-500 flex-shrink-0"
                    title="이번만 닫기"
                  >
                    <X size={13} />
                  </button>
                  <button
                    onClick={() => dismissPermanent(alert.id)}
                    className="text-xs text-gray-300 hover:text-gray-500 whitespace-nowrap flex-shrink-0"
                    title="다시 보지 않기"
                  >
                    다시 안보기
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 지표 카드 ── */}
      {initialLoading ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Card key={i}>
                <CardHeader className="pb-1"><Skeleton className="h-4 w-24" /></CardHeader>
                <CardContent className="space-y-2">
                  <Skeleton className="h-8 w-36" />
                  <Skeleton className="h-3 w-20" />
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[0, 1].map((i) => (
              <Card key={i}>
                <CardHeader className="pb-1"><Skeleton className="h-4 w-20" /></CardHeader>
                <CardContent><Skeleton className="h-8 w-32" /></CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader><Skeleton className="h-5 w-48" /></CardHeader>
            <CardContent><Skeleton className="h-64 w-full" /></CardContent>
          </Card>
        </>
      ) : (
        <>
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${gongguGross > 0 || gongguMargin > 0 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        <Card className="border-green-200">
          <CardHeader className="pb-1"><CardTitle className="text-sm text-gray-500">{selMonth}월 입금액 (바이럴)</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700">{formatKRW(paymentTotal)}</div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <MoMDelta current={paymentTotal} prev={prevPaymentTotal} />
              {refundTotal < 0 && (
                <p className="text-xs text-red-500">환불 {formatKRW(refundTotal)} 차감 후</p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="border-yellow-200 bg-yellow-50">
          <CardHeader className="pb-1"><CardTitle className="text-sm text-yellow-700">수금 예정</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-700">{formatKRW(pendingTotal)}</div>
            <p className="text-xs text-yellow-600 mt-1">잔금·미입금 건 합계</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-gray-500">공급가액</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatKRW(supplyValue)}</div>
            <p className="text-xs text-gray-400 mt-1">VAT 제외</p>
          </CardContent>
        </Card>
        {(gongguGross > 0 || gongguMargin > 0) && (
          <Card className="border-purple-200">
            <CardHeader className="pb-1"><CardTitle className="text-sm text-purple-600">{selMonth}월 공구 취급액 (영세율 0%)</CardTitle></CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-purple-700">{formatKRW(gongguGross)}</div>
              <p className="text-xs text-purple-500 mt-1">
                마진 {formatKRW(gongguMargin)} ·{' '}
                <Link href="/gonggu" className="hover:underline">상세 보기</Link>
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-gray-500">영업이익</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(settlement?.operating_profit ?? 0) < 0 ? 'text-red-600' : 'text-green-600'}`}>
              {settlement ? formatKRW(settlement.operating_profit) : <span className="text-gray-400 text-base">정산 전</span>}
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {settlement && prevSettlement && (
                <MoMDelta current={settlement.operating_profit} prev={prevSettlement.operating_profit} />
              )}
              {settlement && (
                <Link href="/reports/monthly" className="text-xs text-blue-400 hover:underline">상세 보기</Link>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-200 bg-blue-50">
          <CardHeader className="pb-1"><CardTitle className="text-sm text-blue-600">대표자 정산액</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-800">
              {settlement ? formatKRW(settlement.representative_share) : <span className="text-blue-400 text-base">정산 전</span>}
            </div>
          </CardContent>
        </Card>
      </div>


      {/* ── 연간 차트 ── */}
      {monthlyData.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{selYear}년 월별 매출 / 영업이익</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={monthlyData} margin={{ top: 4, right: 20, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000000).toFixed(0)}M`} />
                <Tooltip formatter={(v) => formatKRW(Number(v))} />
                <Bar dataKey="revenue" name="매출" fill="#3b82f6" radius={[3,3,0,0]} />
                <Bar dataKey="profit" name="영업이익" fill="#22c55e" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {monthlyData.length === 0 && !settlement && (
        <Card>
          <CardContent className="py-8 text-center text-gray-400 text-sm">
            아직 정산 데이터가 없습니다.{' '}
            <Link href="/reports/monthly" className="underline text-blue-500">월별 정산</Link>에서 계산해주세요.
          </CardContent>
        </Card>
      )}

      {/* ── 초·중·후순 분포 차트 ── */}
      {periodData.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{selYear}년 초·중·후순 매출 분포</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={periodData} margin={{ top: 4, right: 20, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000000).toFixed(0)}M`} />
                <Tooltip formatter={(v) => formatKRW(Number(v))} />
                <Legend />
                <Bar dataKey="초순" name="초순 (1~10일)" fill="#3b82f6" radius={[3,3,0,0]} />
                <Bar dataKey="중순" name="중순 (11~20일)" fill="#22c55e" radius={[3,3,0,0]} />
                <Bar dataKey="후순" name="후순 (21일~말일)" fill="#f59e0b" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* ── 월별 누적 매출 추이 ── */}
      {availableMonths.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <CardTitle className="flex-1">{selYear}년 월별 누적 매출 추이</CardTitle>
              <div className="flex flex-wrap gap-1">
                {availableMonths.map((m) => {
                  const idx = availableMonths.indexOf(m)
                  const active = activeCurveMonths.includes(m)
                  return (
                    <button
                      key={m}
                      onClick={() => setActiveCurveMonths((prev) =>
                        prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m].sort((a, b) => a - b)
                      )}
                      className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        active ? 'text-white' : 'bg-white text-gray-400 border-gray-200'
                      }`}
                      style={active ? { backgroundColor: CURVE_COLORS[idx % 12], borderColor: CURVE_COLORS[idx % 12] } : {}}
                    >
                      {m}월
                    </button>
                  )
                })}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={curveData} margin={{ top: 4, right: 20, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}일`} ticks={[1, 10, 20, 31]} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000000).toFixed(0)}M`} />
                <Tooltip
                  formatter={(v, name) => [formatKRW(Number(v)), name]}
                  labelFormatter={(label) => `${label}일`}
                />
                <ReferenceLine x={10} stroke="#e5e7eb" strokeDasharray="4 4" />
                <ReferenceLine x={20} stroke="#e5e7eb" strokeDasharray="4 4" />
                {availableMonths
                  .filter((m) => activeCurveMonths.includes(m))
                  .map((m) => (
                    <Line
                      key={m}
                      type="monotone"
                      dataKey={`${m}월`}
                      stroke={CURVE_COLORS[availableMonths.indexOf(m) % 12]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
        </>
      )}
    </div>
  )
}
