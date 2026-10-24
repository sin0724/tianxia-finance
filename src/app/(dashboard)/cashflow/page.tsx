'use client'

/**
 * 현금 흐름 — 최신 통장 잔액 + 미수금 − 반복 지출(최근 3개월 실적 평균) − 부가세 로 3개월 앞을 본다.
 * 통장 내역은 월 마감에서 올린 것을 쓴다. 미수금은 결제 내역의 잔금처리요망·미입금 건.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatKRW } from '@/lib/calculations/settlement'
import type { Forecast } from '@/lib/ledger/forecast'
import { RefreshCw } from 'lucide-react'

const ROWS: { key: 'receivables' | 'payroll' | 'card' | 'fixed' | 'productCost' | 'otherExpense' | 'vat'; label: string; sign: 1 | -1 }[] = [
  { key: 'receivables', label: '+ 미수금 입금 예정', sign: 1 },
  { key: 'payroll', label: '− 급여·4대보험·원천세', sign: -1 },
  { key: 'card', label: '− 카드대금', sign: -1 },
  { key: 'fixed', label: '− 고정비', sign: -1 },
  { key: 'productCost', label: '− 실행비', sign: -1 },
  { key: 'otherExpense', label: '− 기타 경비', sign: -1 },
  { key: 'vat', label: '− 부가세 납부 (추정)', sign: -1 },
]

export default function CashflowPage() {
  const [f, setF] = useState<Forecast | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    fetch('/api/ledger/forecast?months=3')
      .then(async (res) => ({ ok: res.ok, json: await res.json() }))
      .then(({ ok, json }) => {
        if (!alive) return
        if (ok) { setF(json.forecast); setError(null) } else setError(json.error ?? '불러오기 실패')
        setLoading(false)
      })
    return () => { alive = false }
  }, [tick])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">현금 흐름</h1>
          <p className="text-xs text-gray-500 mt-0.5">통장 잔액 + 미수금 − 최근 3개월 평균 지출로 앞으로 3개월을 예측합니다</p>
        </div>
        <button onClick={() => { setLoading(true); setTick((t) => t + 1) }} className="p-2 rounded hover:bg-gray-100" aria-label="새로고침">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {f && !f.asOf && (
        <Card><CardContent className="py-6 text-sm text-gray-500">
          아직 올린 통장 내역이 없습니다. <Link href="/closing" className="underline">월 마감</Link>에서 통장 거래내역을 올려 주세요.
        </CardContent></Card>
      )}

      {f?.asOf && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: `통장 잔액 (${f.asOf})`, value: f.balance },
              { label: `부가세 적립 추정 (${f.vatPeriod.start.slice(5)}~${f.vatPeriod.end.slice(5)}월분, ${f.vatPeriod.due.slice(5)}월 납부)`, value: -f.vatReserve },
              { label: '법인세 적립 (올해 정산 누계)', value: -f.corporateTaxReserve },
              { label: '쓸 수 있는 돈', value: f.available, strong: true },
            ].map((c) => (
              <Card key={c.label}>
                <CardContent className="pt-4">
                  <p className="text-xs text-gray-500">{c.label}</p>
                  <p className={`text-xl font-bold tabular-nums ${c.strong ? (c.value < 0 ? 'text-red-600' : 'text-green-700') : ''}`}>{formatKRW(c.value)}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">앞으로 3개월</CardTitle>
              <p className="text-xs text-gray-500">반복 지출 기준: {f.basisMonths.length ? f.basisMonths.join(', ') : '데이터 없음'} 통장 실적 평균 · 이번 달은 이미 나간 만큼 뺐습니다</p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 border-b">
                  <tr>
                    <th className="text-left py-1.5" />
                    {f.months.map((m) => <th key={m.ym} className="text-right px-2">{m.ym}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="py-1.5 text-gray-600">월초 잔액</td>
                    {f.months.map((m) => <td key={m.ym} className="text-right px-2 tabular-nums">{formatKRW(m.opening)}</td>)}
                  </tr>
                  {ROWS.map((row) => (
                    <tr key={row.key} className="border-b">
                      <td className="py-1.5 text-gray-600">
                        {row.label}
                        {row.key === 'receivables' && f.months[0].overdue > 0 && (
                          <span className="block text-xs text-amber-600">이번 달에 지연분 {formatKRW(f.months[0].overdue)} 포함</span>
                        )}
                      </td>
                      {f.months.map((m) => (
                        <td key={m.ym} className={`text-right px-2 tabular-nums ${row.sign < 0 && m[row.key] ? 'text-red-600' : ''}`}>
                          {m[row.key] ? formatKRW(row.sign * m[row.key]) : '-'}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-2">예상 월말 잔액</td>
                    {f.months.map((m) => <td key={m.ym} className={`text-right px-2 tabular-nums ${m.closing < 0 ? 'text-red-600' : ''}`}>{formatKRW(m.closing)}</td>)}
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">미수금 {f.receivablesList.length}건 · {formatKRW(f.receivablesList.reduce((s, p) => s + p.amount, 0))}</CardTitle>
              <p className="text-xs text-gray-500">통장에 같은 금액이 들어오면 월 마감 업로드 때 자동으로 입금 확정됩니다</p>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {f.receivablesList.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className={`py-1.5 pr-2 whitespace-nowrap ${p.overdue ? 'text-amber-600' : 'text-gray-500'}`}>{p.payment_date}{p.overdue ? ' 지연' : ''}</td>
                      <td className="pr-2">{p.client}</td>
                      <td className="pr-2 text-xs text-gray-400">{p.status === 'balance_due' ? '잔금처리요망' : '미입금'}</td>
                      <td className="text-right tabular-nums">{formatKRW(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
