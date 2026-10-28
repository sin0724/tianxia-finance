'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMonth, yearOptions } from './month-context'

/**
 * 공용 월 네비게이터 — 모든 페이지에서 동일한 선택 월을 조작한다.
 */
export function MonthNavigator() {
  const { year, month, setYearMonth, prevMonth, nextMonth, goToday, isCurrentMonth } = useMonth()

  return (
    <div className="flex items-center gap-0.5 bg-white rounded-xl px-1 py-1 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-gray-200/70">
      <button
        onClick={prevMonth}
        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-900 transition-colors"
        aria-label="이전 달"
      >
        <ChevronLeft size={16} />
      </button>
      <div className="flex items-center gap-1.5 px-2">
        <select
          className="bg-transparent text-[15px] font-bold text-gray-900 focus:outline-none cursor-pointer"
          value={year}
          onChange={(e) => setYearMonth(Number(e.target.value), month)}
        >
          {yearOptions().map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <select
          className="bg-transparent text-[15px] font-bold text-gray-900 focus:outline-none cursor-pointer"
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
        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-900 transition-colors"
        aria-label="다음 달"
      >
        <ChevronRight size={16} />
      </button>
      {!isCurrentMonth && (
        <button onClick={goToday} className="text-xs font-semibold text-blue-500 bg-blue-50 hover:bg-blue-100 rounded-lg px-2 py-1 ml-0.5">
          오늘
        </button>
      )}
    </div>
  )
}
