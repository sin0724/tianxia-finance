import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  CLIENT_SELECT,
  ITEM_SELECT,
  PAYMENT_SELECT,
  PRODUCT_SELECT,
  PROJECT_SELECT,
  buildStaffProgress,
  integrationJson,
  isStaffProgressAuthorized,
  parseStaffProgressFilters,
} from '@/lib/integrations/staff-progress'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * 직원 CRM 용 프로젝트 진행.
 * Authorization: Bearer STAFF_PROGRESS_SECRET
 * 미들웨어는 /api 를 로그인 검사에서 빼 두므로, 여기서만 시크릿을 확인한다.
 *
 * 기존 테이블을 읽어 조합한다. 스키마 변경은 없다.
 * 쿼리: status (ongoing|completed|cancelled)
 */
export async function GET(request: NextRequest) {
  if (!isStaffProgressAuthorized(request)) {
    return integrationJson({ error: 'unauthorized' }, 401)
  }

  const filters = parseStaffProgressFilters(request.nextUrl.searchParams)
  if (!filters.ok) return integrationJson({ error: filters.error }, 400)

  try {
    const admin = createAdminClient()
    let projectsQuery = admin.from('projects').select(PROJECT_SELECT)
    if (filters.status) projectsQuery = projectsQuery.eq('status', filters.status)

    const [projectsRes, clientsRes, paymentsRes, itemsRes, productsRes] = await Promise.all([
      projectsQuery,
      admin.from('clients').select(CLIENT_SELECT),
      admin.from('payments').select(PAYMENT_SELECT),
      admin.from('project_items').select(ITEM_SELECT),
      admin.from('products').select(PRODUCT_SELECT),
    ])

    const error = projectsRes.error ?? clientsRes.error ?? paymentsRes.error ?? itemsRes.error ?? productsRes.error
    if (error) {
      console.error('[staff-progress]', error.message)
      return integrationJson({ error: 'progress_unavailable' }, 500)
    }

    return integrationJson({
      projects: buildStaffProgress({
        projects: projectsRes.data ?? [],
        clients: clientsRes.data ?? [],
        payments: paymentsRes.data ?? [],
        items: itemsRes.data ?? [],
        products: productsRes.data ?? [],
      }),
    })
  } catch (error) {
    console.error('[staff-progress]', error instanceof Error ? error.message : 'unknown')
    return integrationJson({ error: 'progress_unavailable' }, 500)
  }
}
