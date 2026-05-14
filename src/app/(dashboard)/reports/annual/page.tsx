'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatKRW } from '@/lib/calculations/settlement'
import {
  ComposedChart, Bar, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

type MonthlySummary = {
  month: number
  revenue: number
  supply_value: number
  gross_profit: number
  operating_profit: number
  distributable_profit: number
}

type ProductRevenue = { name: string; revenue: number }
type ClientRevenue = { name: string; revenue: number }

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316']
const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']

function formatKRWShort(v: number) {
  if (Math.abs(v) >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}억`
  if (Math.abs(v) >= 10_000) return `${(v / 10_000).toFixed(0)}만`
  return String(v)
}

export default function AnnualReportPage() {
  const supabase = createClient()
  const [year, setYear] = useState(new Date().getFullYear())
  const [monthlySummary, setMonthlySummary] = useState<MonthlySummary[]>([])
  const [productRevenue, setProductRevenue] = useState<ProductRevenue[]>([])
  const [clientRevenue, setClientRevenue] = useState<ClientRevenue[]>([])
  const [settledMonths, setSettledMonths] = useState<Set<number>>(new Set())
  const [totalPending, setTotalPending] = useState(0)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)

    // 1. monthly_settlements에서 연간 데이터
    const { data: settlements } = await supabase
      .from('monthly_settlements')
      .select('*')
      .eq('year', year)
      .order('month')

    const settledMonthSet = new Set((settlements ?? []).map((s) => s.month))

    const summaryMap: Record<number, MonthlySummary> = {}
    for (const s of settlements ?? []) {
      summaryMap[s.month] = {
        month: s.month,
        revenue: s.total_revenue,
        supply_value: s.supply_value,
        gross_profit: s.gross_profit,
        operating_profit: s.operating_profit,
        distributable_profit: s.distributable_profit,
      }
    }

    // payments 기반으로 정산 미계산 월도 채우기
    const { data: paymentData } = await supabase
      .from('payments')
      .select('payment_date, amount, memo')
      .gte('payment_date', `${year}-01-01`)
      .lte('payment_date', `${year}-12-31`)

    let pendingSum = 0
    for (const p of paymentData ?? []) {
      const memo = p.memo ?? ''
      const isPending = memo.includes('⚠ 잔금 처리 요망') || memo.includes('🔴 미입금')
      const isExcluded = memo.includes('🚫 집계 제외')
      if (isPending && !isExcluded) pendingSum += p.amount

      const m = parseInt(p.payment_date.split('-')[1])
      if (!summaryMap[m]) {
        summaryMap[m] = { month: m, revenue: 0, supply_value: 0, gross_profit: 0, operating_profit: 0, distributable_profit: 0 }
      }
      if (!settlements?.find((s) => s.month === m)) {
        summaryMap[m].revenue += p.amount
        summaryMap[m].supply_value += p.amount / 1.1
      }
    }
    setTotalPending(pendingSum)

    const finalSummary = Array.from({ length: 12 }, (_, i) => summaryMap[i + 1] ?? {
      month: i + 1, revenue: 0, supply_value: 0, gross_profit: 0, operating_profit: 0, distributable_profit: 0,
    })
    setMonthlySummary(finalSummary)
    setSettledMonths(settledMonthSet)

    // 2. 상품별 매출 (payments → projects → project_items)
    const { data: items } = await supabase
      .from('project_items')
      .select(`
        quantity,
        unit_price_snapshot,
        products(name, category),
        projects(
          payments(payment_date, amount)
        )
      `)

    const productMap: Record<string, number> = {}
    for (const item of (items as unknown as {
      quantity: number
      unit_price_snapshot: number
      products: { name: string; category: string | null } | null
      projects: { payments: { payment_date: string; amount: number }[] } | null
    }[]) ?? []) {
      const hasPaymentInYear = item.projects?.payments?.some((p) => p.payment_date.startsWith(String(year)))
      if (!hasPaymentInYear) continue
      const productName = item.products?.category ?? item.products?.name ?? '기타'
      const revenue = item.unit_price_snapshot * item.quantity
      productMap[productName] = (productMap[productName] ?? 0) + revenue
    }

    setProductRevenue(
      Object.entries(productMap)
        .map(([name, revenue]) => ({ name, revenue }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 8)
    )

    // 3. 클라이언트별 매출 TOP 10 (미수금 제외)
    const { data: clientPayments } = await supabase
      .from('payments')
      .select('amount, memo, projects(clients(name))')
      .gte('payment_date', `${year}-01-01`)
      .lte('payment_date', `${year}-12-31`)
      .not('memo', 'ilike', '%⚠ 잔금 처리 요망%')
      .not('memo', 'ilike', '%🔴 미입금%')

    const clientMap: Record<string, number> = {}
    for (const p of (clientPayments as unknown as {
      amount: number
      projects: { clients: { name: string } | null } | null
    }[]) ?? []) {
      const clientName = p.projects?.clients?.name ?? '미매칭'
      clientMap[clientName] = (clientMap[clientName] ?? 0) + p.amount
    }

    setClientRevenue(
      Object.entries(clientMap)
        .map(([name, revenue]) => ({ name, revenue }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10)
    )

    setLoading(false)
  }

  useEffect(() => { load() }, [year])

  const totalRevenue = monthlySummary.reduce((s, m) => s + m.revenue, 0)
  const totalOperating = monthlySummary.reduce((s, m) => s + m.operating_profit, 0)
  const totalDistributable = monthlySummary.reduce((s, m) => s + m.distributable_profit, 0)
  const bestMonth = monthlySummary.reduce((best, m) => m.revenue > best.revenue ? m : best, monthlySummary[0] ?? { month: 0, revenue: 0 } as MonthlySummary)

  let cumOp = 0
  const chartData = monthlySummary.map((m) => {
    cumOp += m.operating_profit
    return {
      name: MONTHS[m.month - 1],
      매출: Math.round(m.revenue),
      영업이익: Math.round(m.operating_profit),
      누적영업이익: m.revenue > 0 || m.operating_profit !== 0 ? Math.round(cumOp) : null,
    }
  })

  let cumOpForTable = 0
  const cumulativeProfit = monthlySummary.map((m) => {
    cumOpForTable += m.operating_profit
    return cumOpForTable
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">연간 분석</h1>
        <select
          className="border rounded-md px-3 py-2 text-sm"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[2023, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-gray-500">연간 총매출</p>
          <p className="text-xl font-bold mt-1 text-blue-600">{formatKRW(Math.round(totalRevenue))}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-gray-500">연간 영업이익</p>
          <p className={`text-xl font-bold mt-1 ${totalOperating >= 0 ? 'text-green-600' : 'text-red-500'}`}>{formatKRW(Math.round(totalOperating))}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-gray-500">분배 가능 이익</p>
          <p className="text-xl font-bold mt-1 text-purple-600">{formatKRW(Math.round(totalDistributable))}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-gray-500">미수금 잔액</p>
          <p className={`text-xl font-bold mt-1 ${totalPending > 0 ? 'text-amber-500' : 'text-gray-400'}`}>{formatKRW(Math.round(totalPending))}</p>
          {totalPending > 0 && <p className="text-xs text-gray-400 mt-0.5">미입금 · 잔금 대기</p>}
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-gray-500">최고 매출월</p>
          <p className="text-xl font-bold mt-1 text-orange-600">
            {bestMonth.revenue > 0 ? `${bestMonth.month}월` : '-'}
          </p>
          {bestMonth.revenue > 0 && (
            <p className="text-xs text-gray-400 mt-0.5">{formatKRW(Math.round(bestMonth.revenue))}</p>
          )}
        </div>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">불러오는 중...</div>}

      {!loading && (
        <>
          {/* 월별 매출 / 영업이익 / 누적 추이 */}
          <div className="bg-white rounded-lg border p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">월별 매출 / 영업이익 추이</h2>
            <p className="text-xs text-gray-400 mb-4">주황 선: 누적 영업이익 (정산 완료 월 기준)</p>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={formatKRWShort} tick={{ fontSize: 11 }} width={60} />
                <Tooltip formatter={(v, name) => [formatKRW(Number(v)), name]} />
                <Legend />
                <Bar dataKey="매출" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                <Bar dataKey="영업이익" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Line
                  type="monotone"
                  dataKey="누적영업이익"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#f59e0b' }}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 상품별 매출 기여도 */}
            <div className="bg-white rounded-lg border p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">상품별 매출 기여도</h2>
              {productRevenue.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">데이터 없음</div>
              ) : (
                <div className="flex items-center gap-4">
                  <ResponsiveContainer width={180} height={180}>
                    <PieChart>
                      <Pie data={productRevenue} dataKey="revenue" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={false}>
                        {productRevenue.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => formatKRW(Number(v))} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5">
                    {productRevenue.map((p, i) => (
                      <div key={p.name} className="flex items-center gap-2 text-xs">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                        <span className="flex-1 truncate text-gray-600">{p.name}</span>
                        <span className="font-medium text-gray-800">{formatKRW(p.revenue)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 클라이언트별 매출 TOP 10 */}
            <div className="bg-white rounded-lg border p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">클라이언트별 매출 TOP 10</h2>
              {clientRevenue.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">데이터 없음</div>
              ) : (
                <div className="space-y-2">
                  {clientRevenue.map((c, i) => {
                    const maxRevenue = clientRevenue[0]?.revenue ?? 1
                    const pct = Math.round(c.revenue / maxRevenue * 100)
                    return (
                      <div key={c.name} className="flex items-center gap-2 text-sm">
                        <span className="w-5 text-xs text-gray-400 text-right">{i + 1}</span>
                        <span className="w-28 truncate text-gray-700">{c.name}</span>
                        <div className="flex-1 bg-gray-100 rounded-full h-2">
                          <div className="bg-blue-400 h-2 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-24 text-right font-medium text-gray-800">{formatKRW(c.revenue)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 월별 상세 테이블 */}
          <div className="bg-white rounded-lg border p-4 overflow-x-auto">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">월별 손익 상세</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-gray-500">
                  <th className="text-left py-2 font-medium">월</th>
                  <th className="text-center py-2 font-medium">정산</th>
                  <th className="text-right py-2 font-medium">총매출</th>
                  <th className="text-right py-2 font-medium">공급가액</th>
                  <th className="text-right py-2 font-medium">매출총이익</th>
                  <th className="text-right py-2 font-medium">영업이익</th>
                  <th className="text-right py-2 font-medium text-amber-600">누적 영업이익</th>
                  <th className="text-right py-2 font-medium">분배가능이익</th>
                </tr>
              </thead>
              <tbody>
                {monthlySummary.map((m, i) => (
                  <tr key={m.month} className={`border-b hover:bg-gray-50 ${m.month === bestMonth.month && m.revenue > 0 ? 'bg-blue-50' : ''}`}>
                    <td className="py-2">{m.month}월{m.month === bestMonth.month && m.revenue > 0 && <span className="ml-1 text-xs text-blue-500">★</span>}</td>
                    <td className="text-center">
                      {settledMonths.has(m.month)
                        ? <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">정산완료</span>
                        : m.revenue > 0
                          ? <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">미정산</span>
                          : null}
                    </td>
                    <td className="text-right">{m.revenue > 0 ? formatKRW(Math.round(m.revenue)) : <span className="text-gray-300">-</span>}</td>
                    <td className="text-right">{m.supply_value > 0 ? formatKRW(Math.round(m.supply_value)) : <span className="text-gray-300">-</span>}</td>
                    <td className="text-right">{m.gross_profit !== 0 ? formatKRW(Math.round(m.gross_profit)) : <span className="text-gray-300">-</span>}</td>
                    <td className={`text-right ${m.operating_profit < 0 ? 'text-red-500' : m.operating_profit > 0 ? 'text-green-600' : 'text-gray-300'}`}>
                      {m.operating_profit !== 0 ? formatKRW(Math.round(m.operating_profit)) : '-'}
                    </td>
                    <td className={`text-right font-medium ${cumulativeProfit[i] < 0 ? 'text-red-500' : cumulativeProfit[i] > 0 ? 'text-amber-600' : 'text-gray-300'}`}>
                      {(m.revenue > 0 || m.operating_profit !== 0) ? formatKRW(Math.round(cumulativeProfit[i])) : <span className="text-gray-300">-</span>}
                    </td>
                    <td className="text-right">{m.distributable_profit !== 0 ? formatKRW(Math.round(m.distributable_profit)) : <span className="text-gray-300">-</span>}</td>
                  </tr>
                ))}
                <tr className="font-semibold border-t-2 bg-gray-50">
                  <td className="py-2">합계</td>
                  <td />
                  <td className="text-right">{formatKRW(Math.round(totalRevenue))}</td>
                  <td className="text-right">{formatKRW(Math.round(monthlySummary.reduce((s, m) => s + m.supply_value, 0)))}</td>
                  <td className="text-right">{formatKRW(Math.round(monthlySummary.reduce((s, m) => s + m.gross_profit, 0)))}</td>
                  <td className={`text-right ${totalOperating < 0 ? 'text-red-500' : 'text-green-600'}`}>{formatKRW(Math.round(totalOperating))}</td>
                  <td className={`text-right ${totalOperating < 0 ? 'text-red-500' : 'text-amber-600'}`}>{formatKRW(Math.round(totalOperating))}</td>
                  <td className="text-right">{formatKRW(Math.round(totalDistributable))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
