import { notFound } from 'next/navigation'
import { getAdmin } from '@/lib/auth/admin'
import { IncentivesClient } from '@/components/incentives/incentives-client'

/**
 * 인센티브 정산 — 관리자(app_admins)만. 다른 사람에게는 없는 페이지(404)로 보인다.
 * 데이터는 /api/incentives/* 가 다시 관리자를 확인하고, 표마다 관리자만 통과하는 RLS가 걸려 있다.
 */
export default async function IncentivesPage() {
  if (!(await getAdmin())) notFound()
  return <IncentivesClient />
}

export const dynamic = 'force-dynamic'
