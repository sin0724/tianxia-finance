'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from './sidebar'

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex min-h-screen">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-gray-900 text-white shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1 rounded hover:bg-gray-700 transition-colors"
            aria-label="메뉴 열기"
          >
            <Menu size={20} />
          </button>
          <span className="text-sm font-bold">티엔샤 재무관리</span>
        </header>

        <main className="flex-1 bg-gray-50 overflow-auto">
          <div className="p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  )
}
