'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Package,
  Users,
  Building2,
  CreditCard,
  Receipt,
  BarChart3,
  TrendingUp,
  FileSpreadsheet,
  FolderKanban,
  Settings,
  LogOut,
} from 'lucide-react'

const navItems = [
  { href: '/',                  label: '대시보드',    icon: LayoutDashboard },
  { href: '/products',          label: '상품 관리',    icon: Package },
  { href: '/clients',           label: '클라이언트',   icon: Building2 },
  { href: '/projects',          label: '프로젝트',     icon: FolderKanban },
  { href: '/employees',         label: '직원/급여',    icon: Users },
  { href: '/payments',          label: '결제 내역',    icon: CreditCard },
  { href: '/expenses',          label: '월별 지출',    icon: Receipt },
  { href: '/reports/monthly',   label: '월별 정산',    icon: BarChart3 },
  { href: '/reports/annual',    label: '연간 분석',    icon: TrendingUp },
  { href: '/payroll',           label: '급여대장',      icon: FileSpreadsheet },
  { href: '/settings',          label: '설정',        icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="w-60 min-h-screen bg-gray-900 text-white flex flex-col">
      <div className="px-6 py-5 border-b border-gray-700">
        <h1 className="text-lg font-bold">티엔샤 재무관리</h1>
        <p className="text-xs text-gray-400 mt-0.5">Tianxia Corporation</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
              pathname === href
                ? 'bg-blue-600 text-white'
                : 'text-gray-300 hover:bg-gray-800 hover:text-white'
            )}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-gray-700">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors w-full"
        >
          <LogOut size={16} />
          로그아웃
        </button>
      </div>
    </aside>
  )
}
