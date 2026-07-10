'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMonth, yearOptions } from './month-context'

/**
 * 공용 월 네비게이터 — 모든 페이지에서 동일한 선택 월을 조작한다.
 */
export function MonthNavigator() {
  const { year, month, setYearMonth, prevMonth, nextMonth, goToday, isCurrentMonth } = useMonth()

  return (
    <div className="flex items-center gap-1 bg-gray-100 rounded-lg px-1 py-1">
      <button
        onClick={prevMonth}
        className="p-1 rounded hover:bg-white text-gray-500 hover:text-gray-900 transition-colors"
        aria-label="이전 달"
      >
        <ChevronLeft size={16} />
      </button>
      <div className="flex items-center gap-1.5 px-2">
        <select
          className="bg-transparent text-sm font-semibold focus:outline-none cursor-pointer"
          value={year}
          onChange={(e) => setYearMonth(Number(e.target.value), month)}
        >
          {yearOptions().map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <select
          className="bg-transparent text-sm font-semibold focus:outline-none cursor-pointer"
          value={month}
          onChange={(e) => setYearMonth(year, Number(e.target.value))}
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{m}월</option>
          ))}
        </select>
      </div>
      <button
        onClick={nextMonth}
        className="p-1 rounded hover:bg-white text-gray-500 hover:text-gray-900 transition-colors"
        aria-label="다음 달"
      >
        <ChevronRight size={16} />
      </button>
      {!isCurrentMonth && (
        <button onClick={goToday} className="text-xs text-blue-500 hover:text-blue-700 px-1.5">
          오늘
        </button>
      )}
    </div>
  )
}
