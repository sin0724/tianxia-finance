'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from './sidebar'
import { MonthProvider } from './month-context'

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <MonthProvider>
    <div className="flex min-h-screen bg-gray-100">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden sticky top-0 z-10 flex items-center gap-2 px-3 h-14 bg-white/90 backdrop-blur border-b border-gray-100 shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-xl text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="메뉴 열기"
          >
            <Menu size={20} />
          </button>
          <span className="text-[15px] font-bold text-gray-900">티엔샤 재무관리</span>
        </header>

        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-8 md:py-8">{children}</div>
        </main>
      </div>
    </div>
    </MonthProvider>
  )
}
