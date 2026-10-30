import { createAdminClient } from '@/lib/supabase/admin'
import {
  EMPLOYEE_SELECT,
  integrationJson,
  isStaffProgressAuthorized,
  shapeEmployee,
} from '@/lib/integrations/staff-progress'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** 재직 중 직원의 id, name. Authorization: Bearer STAFF_PROGRESS_SECRET */
export async function GET(request: Request) {
  if (!isStaffProgressAuthorized(request)) {
    return integrationJson({ error: 'unauthorized' }, 401)
  }

  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('employees')
      .select(EMPLOYEE_SELECT)
      .eq('active', true)
      .order('name', { ascending: true })

    if (error) {
      console.error('[staff-employees]', error.message)
      return integrationJson({ error: 'employees_unavailable' }, 500)
    }

    return integrationJson({
      employees: (data ?? []).flatMap((row) => {
        const employee = shapeEmployee(row)
        return employee ? [employee] : []
      }),
    })
  } catch (error) {
    console.error('[staff-employees]', error instanceof Error ? error.message : 'unknown')
    return integrationJson({ error: 'employees_unavailable' }, 500)
  }
}
