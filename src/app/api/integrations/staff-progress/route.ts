import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  STAFF_PROGRESS_SELECT,
  integrationJson,
  isStaffProgressAuthorized,
  parseStaffProgressFilters,
  shapeStaffProgress,
} from '@/lib/integrations/staff-progress'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * 직원 CRM 용 프로젝트 진행.
 * Authorization: Bearer STAFF_PROGRESS_SECRET
 * 미들웨어는 /api 를 로그인 검사에서 빼 두므로, 여기서만 시크릿을 확인한다.
 *
 * 쿼리: status (ongoing|completed|cancelled), assignee (직원 UUID 또는 이름)
 */
export async function GET(request: NextRequest) {
  if (!isStaffProgressAuthorized(request)) {
    return integrationJson({ error: 'unauthorized' }, 401)
  }

  const filters = parseStaffProgressFilters(request.nextUrl.searchParams)
  if (!filters.ok) return integrationJson({ error: filters.error }, 400)

  try {
    const admin = createAdminClient()
    let query = admin.from('staff_project_progress').select(STAFF_PROGRESS_SELECT)
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.assigneeId) query = query.eq('assignee_employee_id', filters.assigneeId)
    else if (filters.assigneeName) query = query.eq('assignee_name', filters.assigneeName)

    const { data, error } = await query
      .order('contract_date', { ascending: false, nullsFirst: false })
      .order('project_name', { ascending: true })

    if (error) {
      console.error('[staff-progress]', error.message)
      return integrationJson({ error: 'progress_unavailable' }, 500)
    }

    return integrationJson({
      projects: (data ?? []).map((row) => shapeStaffProgress(row)),
    })
  } catch (error) {
    console.error('[staff-progress]', error instanceof Error ? error.message : 'unknown')
    return integrationJson({ error: 'progress_unavailable' }, 500)
  }
}
