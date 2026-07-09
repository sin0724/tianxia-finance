'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatKRW } from '@/lib/calculations/settlement'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, ReferenceLine,
} from 'recharts'
import type { MonthlySettlement } from '@/types/database'
import Link from 'next/link'
import { Bell, RefreshCw, X, ChevronLeft, ChevronRight, Calendar, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

const CURVE_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
  '#6366f1', '#10b981', '#e11d48', '#0ea5e9',
]

type DashAlert = { id: string; message: string; href: string; level: 'warn' | 'info' }
type PeriodRow = { month: string; 초순: number; 중순: number; 후순: number }


export default function DashboardPage() {
  const supabase = createClient()
  const now = new Date()

  // ── 선택 월 ──────────────────────────────────────────────
  const [selYear, setSelYear]   = useState(now.getFullYear())
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1)
  const isCurrentMonth = selYear === now.getFullYear() && selMonth === now.getMonth() + 1

  // ── 데이터 ────────────────────────────────────────────────
  const [settlement, setSettlement]   = useState<MonthlySettlement | null>(null)
  const [monthlyData, setMonthlyData] = useState<{ month: string; revenue: number; profit: number }[]>([])
  const [paymentTotal, setPaymentTotal]   = useState(0)
  const [refundTotal, setRefundTotal]     = useState(0)
  const [pendingTotal, setPendingTotal]   = useState(0)
  const [gongguGross, setGongguGross]     = useState(0)
  const [gongguMargin, setGongguMargin]   = useState(0)
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
  const [lastSyncTime, setLastSyncTime]   = useState<string | null>(null)
  const [syncFrom, setSyncFrom]           = useState(() => {
    // 기본: 현재 월 1일
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [showSyncOptions, setShowSyncOptions] = useState(false)

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('dash_alerts_dismissed') ?? '[]')
      setPermanentDismissed(new Set(stored as string[]))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load() }, [selYear, selMonth])

  // 선택 월 변경 시 세션 알림 초기화
  useEffect(() => { setDismissedAlerts(new Set()) }, [selYear, selMonth])

  async function load() {
    const start = `${selYear}-${String(selMonth).padStart(2, '0')}-01`
    const lastDay = new Date(selYear, selMonth, 0).getDate()
    const end   = `${selYear}-${String(selMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    // 정산
    const { data: s } = await supabase
      .from('monthly_settlements').select('*')
      .eq('year', selYear).eq('month', selMonth).single()
    setSettlement(s)

    // 연간 추이 (선택 연도 기준)
    const { data: settlements } = await supabase
      .from('monthly_settlements')
      .select('year, month, total_revenue, operating_profit')
      .eq('year', selYear).order('month')
    setMonthlyData((settlements ?? []).map((r) => ({
      month: MONTH_LABELS[r.month - 1],
      revenue: r.total_revenue,
      profit: r.operating_profit,
    })))

    // 결제 (이번 달 — 확정 입금액·미매칭 알림용, 취소 프로젝트 제외)
    const { data: payments } = await supabase
      .from('payments')
      .select('amount, matched, memo, projects(status)')
      .gte('payment_date', start)
      .lte('payment_date', end)

    const isPending = (p: { memo: string | null }) =>
      !!(p.memo?.includes('⚠ 잔금 처리 요망') || p.memo?.includes('🔴 미입금'))

    const isExcluded = (p: { memo: string | null }) =>
      !!(p.memo?.includes('🚫 집계 제외'))

    type PaymentRow = { amount: number; matched: boolean; memo: string | null; projects: { status: string } | null }
    const paymentRows = (payments as unknown as PaymentRow[]) ?? []

    const confirmed = paymentRows.filter((p) => !isPending(p) && !isExcluded(p) && p.projects?.status !== 'cancelled')
    const unmatched = paymentRows.filter((p) => !p.matched)

    // 수금 예정 — 수금 관리 탭과 동일하게 전체 기간 미수금 합산 (취소 프로젝트 제외)
    const { data: allPending } = await supabase
      .from('payments')
      .select('amount, projects(status)')
      .or('memo.ilike.*⚠ 잔금 처리 요망*,memo.ilike.*🔴 미입금*')

    type PendingRow = { amount: number; projects: { status: string } | null }
    const refunds = confirmed.filter((p) => p.amount < 0)
    setPaymentTotal(confirmed.reduce((s, p) => s + p.amount, 0))
    setRefundTotal(refunds.reduce((s, p) => s + p.amount, 0))
    setPendingTotal(((allPending as unknown as PendingRow[]) ?? [])
      .filter((p) => p.projects?.status !== 'cancelled')
      .reduce((s, p) => s + p.amount, 0))


    // 공구 사업부 실적 (선택 월)
    const { data: gongguRows } = await supabase
      .from('gonggu_sales')
      .select('gross_sales, margin')
      .eq('year', selYear)
      .eq('month', selMonth)
    setGongguGross((gongguRows ?? []).reduce((s, r) => s + r.gross_sales, 0))
    setGongguMargin((gongguRows ?? []).reduce((s, r) => s + r.margin, 0))

    // ── 초·중·후순 / 누적 추이 차트 ────────────────────────
    const { data: yrRaw } = await supabase
      .from('payments')
      .select('payment_date, amount, memo, projects(status)')
      .gte('payment_date', `${selYear}-01-01`)
      .lte('payment_date', `${selYear}-12-31`)

    type YrRow = { payment_date: string; amount: number; memo: string | null; projects: { status: string } | null }
    const yrFiltered = ((yrRaw as unknown as YrRow[]) ?? [])
      .filter((p) => p.amount > 0)
      .filter((p) => !p.memo?.includes('🚫 집계 제외'))
      .filter((p) => !p.memo?.includes('⚠ 잔금 처리 요망') && !p.memo?.includes('🔴 미입금'))
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
        const lastDay = new Date(selYear, m, 0).getDate()
        if (day > lastDay) continue
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
      const { data: exp } = await supabase.from('monthly_expenses').select('id')
        .eq('year', selYear).eq('month', selMonth).limit(1)
      if (!exp || exp.length === 0)
        newAlerts.push({ id: `expenses_${ym}`, level: 'info',
          message: `${selMonth}월 지출이 아직 입력되지 않았습니다.`, href: '/expenses' })

      const { data: emps } = await supabase.from('employees').select('id').eq('active', true).limit(1)
      if (emps && emps.length > 0) {
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
  }

  function prevMonth() {
    if (selMonth === 1) { setSelYear(y => y - 1); setSelMonth(12) }
    else setSelMonth(m => m - 1)
  }
  function nextMonth() {
    if (selMonth === 12) { setSelYear(y => y + 1); setSelMonth(1) }
    else setSelMonth(m => m + 1)
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
      const parts = [`${data.synced}건 추가`, `${data.skipped}건 중복`]
      if (data.created > 0) parts.push(`프로젝트 ${data.created}개 생성`)
      if (data.pending > 0) parts.push(`⚠ 수금 예정 ${data.pending}건`)
      if (data.unmatched > 0) parts.push(`미매칭 ${data.unmatched}건`)
      toast.success(`동기화 완료: ${parts.join(', ')}`)
      setLastSyncTime(new Date().toLocaleTimeString('ko-KR'))
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
      try { localStorage.setItem('dash_alerts_dismissed', JSON.stringify([...next])) } catch { /* ignore */ }
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

  return (
    <div className="space-y-6">

      {/* ── 헤더 ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">대시보드</h1>
          {/* 월 네비게이터 */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg px-1 py-1">
            <button onClick={prevMonth} className="p-1 rounded hover:bg-white text-gray-500 hover:text-gray-900 transition-colors">
              <ChevronLeft size={16} />
            </button>
            <div className="flex items-center gap-1.5 px-2">
              <select
                className="bg-transparent text-sm font-semibold focus:outline-none cursor-pointer"
                value={selYear}
                onChange={(e) => setSelYear(Number(e.target.value))}
              >
                {[2023, 2024, 2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}년</option>)}
              </select>
              <select
                className="bg-transparent text-sm font-semibold focus:outline-none cursor-pointer"
                value={selMonth}
                onChange={(e) => setSelMonth(Number(e.target.value))}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{m}월</option>
                ))}
              </select>
            </div>
            <button onClick={nextMonth} className="p-1 rounded hover:bg-white text-gray-500 hover:text-gray-900 transition-colors">
              <ChevronRight size={16} />
            </button>
            {!isCurrentMonth && (
              <button
                onClick={() => { setSelYear(now.getFullYear()); setSelMonth(now.getMonth() + 1) }}
                className="text-xs text-blue-500 hover:text-blue-700 px-1.5"
              >
                오늘
              </button>
            )}
          </div>
          {!isCurrentMonth && (
            <Badge variant="secondary" className="text-xs">과거 데이터</Badge>
          )}
        </div>

        {/* 동기화 */}
        <div className="flex items-center gap-2 relative self-start sm:self-auto">
          {lastSyncTime && <span className="text-xs text-gray-400">마지막 동기화: {lastSyncTime}</span>}
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
              <button
                onClick={(e) => { e.stopPropagation(); dismissAllSession() }}
                className="ml-auto text-xs text-gray-400 hover:text-gray-600 mr-1"
              >
                모두 닫기
              </button>
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
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${gongguGross > 0 || gongguMargin > 0 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        <Card className="border-green-200">
          <CardHeader className="pb-1"><CardTitle className="text-sm text-gray-500">{selMonth}월 입금액 (바이럴)</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700">{formatKRW(paymentTotal)}</div>
            {refundTotal < 0 ? (
              <p className="text-xs text-red-500 mt-1">환불 {formatKRW(refundTotal)} 차감 후</p>
            ) : (
              <p className="text-xs text-gray-400 mt-1">입금완료 건 합계</p>
            )}
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
            <div className="text-2xl font-bold">{formatKRW(settlement?.supply_value ?? paymentTotal / 1.1)}</div>
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
            {settlement && (
              <Link href="/reports/monthly" className="text-xs text-blue-400 hover:underline">상세 보기</Link>
            )}
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
    </div>
  )
}
