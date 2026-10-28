'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { countUnmatchedPayments } from '@/lib/payments/unmatched'
import { countPendingLeaves } from '@/lib/leave/pending'
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
  ShoppingBag,
  CalendarCheck,
  ClipboardCheck,
  Wallet,
  Settings,
  LogOut,
  X,
} from 'lucide-react'

type NavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
  badge?: 'unmatched' | 'pendingLeave'
}

const navGroups: { title: string | null; items: NavItem[] }[] = [
  {
    title: null,
    items: [
      { href: '/', label: '대시보드', icon: LayoutDashboard },
    ],
  },
  {
    title: '영업',
    items: [
      { href: '/products',  label: '상품 관리',   icon: Package },
      { href: '/clients',   label: '클라이언트',  icon: Building2 },
      { href: '/projects',  label: '프로젝트',    icon: FolderKanban },
      { href: '/gonggu',    label: '공구 사업부', icon: ShoppingBag },
    ],
  },
  {
    title: '자금',
    items: [
      { href: '/closing',   label: '월 마감',   icon: ClipboardCheck },
      { href: '/cashflow',  label: '현금 흐름', icon: Wallet },
      { href: '/payments',  label: '결제 내역', icon: CreditCard, badge: 'unmatched' },
      { href: '/expenses',  label: '월별 지출', icon: Receipt },
      { href: '/payroll',   label: '급여 관리', icon: FileSpreadsheet },
    ],
  },
  {
    title: '인사',
    items: [
      { href: '/employees', label: '직원 관리', icon: Users },
      { href: '/leave',     label: '연차 관리', icon: CalendarCheck, badge: 'pendingLeave' },
    ],
  },
  {
    title: '리포트',
    items: [
      { href: '/reports/monthly', label: '월별 정산', icon: BarChart3 },
      { href: '/reports/annual',  label: '연간 분석', icon: TrendingUp },
    ],
  },
  {
    title: null,
    items: [
      { href: '/settings', label: '설정', icon: Settings },
    ],
  },
]

interface SidebarProps {
  open?: boolean
  onClose?: () => void
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [unmatchedCount, setUnmatchedCount] = useState(0)
  const [pendingLeaveCount, setPendingLeaveCount] = useState(0)

  // 배지 갱신 — 페이지 이동·창 포커스 시. 각 판정 기준은 lib 한 곳에서만 정의한다
  // (countUnmatchedPayments / countPendingLeaves — 대시보드·목록 필터와 같은 기준)
  useEffect(() => {
    let alive = true
    const supabase = createClient()
    const refresh = async () => {
      const [unmatched, pendingLeave] = await Promise.all([
        countUnmatchedPayments(supabase),
        countPendingLeaves(supabase),
      ])
      if (!alive) return
      setUnmatchedCount(unmatched)
      setPendingLeaveCount(pendingLeave)
    }
    refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    window.addEventListener('refresh-badges', refresh)
    document.addEventListener('visibilitychange', onVisible)

    // Slack 으로 들어온 연차 신청은 이 화면과 무관하게 생기므로 주기적으로도 확인한다.
    // 화면을 열어둔 채 있어도 승인 대기 배지가 뜨게 하려는 것 — 탭이 숨겨져 있으면 건너뛴다.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 60_000)

    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('refresh-badges', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pathname])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside
      className={cn(
        'w-64 bg-white border-r border-gray-100 flex flex-col',
        'fixed inset-y-0 left-0 z-30 transition-transform duration-200',
        'md:sticky md:top-0 md:h-screen md:translate-x-0 md:z-auto',
        open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
      )}
    >
      <div className="px-5 h-16 flex items-center justify-between shrink-0">
        <Link href="/" onClick={onClose} className="flex items-center gap-2.5">
          <span className="size-8 rounded-[10px] bg-blue-500 text-white flex items-center justify-center text-sm font-extrabold">
            T
          </span>
          <span className="text-[15px] font-bold text-gray-900 tracking-tight">티엔샤 재무관리</span>
        </Link>
        <button
          onClick={onClose}
          className="md:hidden p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400"
          aria-label="메뉴 닫기"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 px-3 pb-4 overflow-y-auto">
        {navGroups.map((group, gi) => (
          <div key={gi} className={gi > 0 ? 'mt-5' : 'mt-2'}>
            {group.title && (
              <p className="px-3 mb-1.5 text-xs font-semibold text-gray-400">
                {group.title}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon, badge }) => {
                const active = pathname === href
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={onClose}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 rounded-xl text-[15px] transition-colors',
                      active
                        ? 'bg-gray-100 text-gray-900 font-bold'
                        : 'text-gray-600 font-medium hover:bg-gray-50 hover:text-gray-900'
                    )}
                  >
                    <Icon size={18} className={active ? 'text-blue-500' : 'text-gray-400'} />
                    <span className="flex-1">{label}</span>
                    {badge === 'unmatched' && unmatchedCount > 0 && (
                      <span
                        className="text-[11px] font-bold bg-red-500 text-white rounded-full px-1.5 py-0.5 min-w-5 text-center"
                        title={`프로젝트 미연결 입금 ${unmatchedCount}건 (전체 기간) — 결제 내역의 '미연결만' 필터에서 연결해주세요`}
                      >
                        {unmatchedCount}
                      </span>
                    )}
                    {badge === 'pendingLeave' && pendingLeaveCount > 0 && (
                      <span
                        className="text-[11px] font-bold bg-orange-500 text-white rounded-full px-1.5 py-0.5 min-w-5 text-center"
                        title={`승인 대기중인 연차 신청 ${pendingLeaveCount}건`}
                      >
                        {pendingLeaveCount}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-3 py-3 border-t border-gray-100">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-[15px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors w-full"
        >
          <LogOut size={18} className="text-gray-400" />
          로그아웃
        </button>
      </div>
    </aside>
  )
}
