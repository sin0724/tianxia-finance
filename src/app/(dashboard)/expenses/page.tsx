'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatKRW } from '@/lib/calculations/settlement'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'

const TYPE_LABEL: Record<string, string> = { fixed: '고정비', variable: '변동비', special: '특수비용' }

type ExpenseItem = {
  id: string
  item_name: string | null
  parent_type: string | null
  amount: number
  memo: string | null
}

/** 예전 수기 지출 조회 전용 — 지금은 월 마감의 통장·카드 내역이 정산 기준이다 */
export default function ExpensesPage() {
  const { year, month } = useMonth()
  const [items, setItems] = useState<ExpenseItem[]>([])

  useEffect(() => {
    createClient().from('monthly_expenses').select('id, item_name, parent_type, amount, memo')
      .eq('year', year).eq('month', month).order('created_at')
      .then(({ data }) => setItems(data ?? []))
  }, [year, month])

  const total = items.reduce((sum, i) => sum + i.amount, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">월별 지출 기록</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            예전 수기 입력 조회용이에요. 지출은 <Link href="/closing" className="underline">월 마감</Link>에서 통장·카드 내역으로 집계합니다.
          </p>
        </div>
        <MonthNavigator />
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">{year}년 {month}월 수기 지출 기록이 없습니다.</p>
      ) : (
        <>
          {(['fixed', 'variable', 'special'] as const).map((type) => {
            const rows = items.filter((i) => (i.parent_type ?? 'fixed') === type)
            if (rows.length === 0) return null
            return (
              <Card key={type}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {TYPE_LABEL[type]} <span className="text-xs font-normal text-gray-500">{formatKRW(rows.reduce((s, i) => s + i.amount, 0))}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {rows.map((i) => (
                    <div key={i.id} className="flex items-center justify-between gap-3 py-1.5 text-sm border-b last:border-0">
                      <div className="min-w-0">
                        <div className="truncate">{i.item_name ?? '(항목명 없음)'}</div>
                        {i.memo && <div className="text-xs text-gray-500 truncate">{i.memo}</div>}
                      </div>
                      <span className="tabular-nums shrink-0">{formatKRW(i.amount)}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )
          })}
          <div className="bg-white rounded-lg border p-4 text-sm text-gray-500">
            {year}년 {month}월 총 지출: <span className="font-bold text-gray-900 text-base">{formatKRW(total)}</span>
          </div>
        </>
      )}
    </div>
  )
}
