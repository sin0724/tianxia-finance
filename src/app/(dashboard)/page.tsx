'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatKRW } from '@/lib/calculations/settlement'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import type { MonthlySettlement } from '@/types/database'
import Link from 'next/link'
import { Bell, RefreshCw, X, ChevronLeft, ChevronRight, Calendar, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

type DashAlert = { id: string; message: string; href: string; level: 'warn' | 'info' }


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
  const [pendingTotal, setPendingTotal]   = useState(0)
  const [alerts, setAlerts]               = useState<DashAlert[]>([])
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())
  const [permanentDismissed, setPermanentDismissed] = useState<Set<string>>(new Set())
  const [alertsOpen, setAlertsOpen] = useState(true)

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
    setPaymentTotal(confirmed.reduce((s, p) => s + p.amount, 0))
    setPendingTotal(((allPending as unknown as PendingRow[]) ?? [])
      .filter((p) => p.projects?.status !== 'cancelled')
      .reduce((s, p) => s + p.amount, 0))


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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="border-green-200">
          <CardHeader className="pb-1"><CardTitle className="text-sm text-gray-500">{selMonth}월 입금액</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-700">{formatKRW(paymentTotal)}</div>
            <p className="text-xs text-gray-400 mt-1">입금완료 건 합계</p>
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
    </div>
  )
}
