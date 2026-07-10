'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'

/**
 * 대시보드 전체에서 공유되는 선택 연·월.
 * - 레이아웃에 Provider가 있어 페이지를 이동해도 선택한 월이 유지된다.
 * - ?ym=YYYY-MM URL 파라미터와 동기화되어 새로고침·링크 공유에도 유지된다.
 */

interface MonthContextValue {
  year: number
  month: number
  setYearMonth: (year: number, month: number) => void
  prevMonth: () => void
  nextMonth: () => void
  goToday: () => void
  isCurrentMonth: boolean
}

const MonthContext = createContext<MonthContextValue | null>(null)

function parseYm(search: string): { year: number; month: number } | null {
  const m = new URLSearchParams(search).get('ym')?.match(/^(\d{4})-(\d{1,2})$/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return { year, month }
}

export function MonthProvider({ children }: { children: React.ReactNode }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  // 첫 로드 시 URL의 ?ym= 복원 — SSR 마크업과의 hydration 불일치를 피하려면
  // 초기값이 아닌 마운트 후 effect에서 반영해야 한다.
  useEffect(() => {
    const parsed = parseYm(window.location.search)
    if (parsed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setYear(parsed.year)
      setMonth(parsed.month)
    }
  }, [])

  const setYearMonth = useCallback((y: number, m: number) => {
    setYear(y)
    setMonth(m)
    const url = new URL(window.location.href)
    url.searchParams.set('ym', `${y}-${String(m).padStart(2, '0')}`)
    window.history.replaceState(window.history.state, '', url)
  }, [])

  const prevMonth = useCallback(() => {
    if (month === 1) setYearMonth(year - 1, 12)
    else setYearMonth(year, month - 1)
  }, [year, month, setYearMonth])

  const nextMonth = useCallback(() => {
    if (month === 12) setYearMonth(year + 1, 1)
    else setYearMonth(year, month + 1)
  }, [year, month, setYearMonth])

  const goToday = useCallback(() => {
    const d = new Date()
    setYearMonth(d.getFullYear(), d.getMonth() + 1)
  }, [setYearMonth])

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1

  return (
    <MonthContext.Provider value={{ year, month, setYearMonth, prevMonth, nextMonth, goToday, isCurrentMonth }}>
      {children}
    </MonthContext.Provider>
  )
}

export function useMonth(): MonthContextValue {
  const ctx = useContext(MonthContext)
  if (!ctx) throw new Error('useMonth는 MonthProvider 안에서만 사용할 수 있습니다.')
  return ctx
}

/** 연도 옵션 — 데이터 시작 연도(2023)부터 내년까지 */
export function yearOptions(): number[] {
  const current = new Date().getFullYear()
  const years: number[] = []
  for (let y = 2023; y <= current + 1; y++) years.push(y)
  return years
}
