import { createAdminClient } from '@/lib/supabase/admin'
import {
  DELIVERY_SELECT,
  ITEM_LOOKUP_SELECT,
  PRODUCT_CATEGORY_SELECT,
  deliveryDateOrToday,
  integrationJson,
  isStaffProgressAuthorized,
  matchItemIdsByCategory,
  parseDeliveryBody,
  shapeDelivery,
  type DeliveryInput,
} from '@/lib/integrations/staff-progress'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Admin = ReturnType<typeof createAdminClient>

/**
 * 납품 기록. Authorization: Bearer STAFF_PROGRESS_SECRET
 *
 * 본문: project_item_id 또는 (project_id + category), quantity, delivered_at?, note?, external_key?
 * external_key 가 이미 있으면 기존 행을 그대로 돌려준다.
 */
export async function POST(request: Request) {
  if (!isStaffProgressAuthorized(request)) {
    return integrationJson({ error: 'unauthorized' }, 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return integrationJson({ error: 'invalid_body' }, 400)
  }

  const parsed = parseDeliveryBody(body)
  if (!parsed.ok) return integrationJson({ error: parsed.error }, 400)
  const input = parsed.value

  try {
    return await createDelivery(input)
  } catch (error) {
    console.error('[deliveries]', error instanceof Error ? error.message : 'unknown')
    return integrationJson({ error: 'delivery_failed' }, 500)
  }
}

async function createDelivery(input: DeliveryInput) {
  const admin = createAdminClient()

  if (input.externalKey) {
    const existing = await findDeliveryByExternalKey(admin, input.externalKey)
    if (existing.error) {
      console.error('[deliveries] lookup', existing.error)
      return integrationJson({ error: 'delivery_failed' }, 500)
    }
    if (existing.data) {
      return integrationJson({ delivery: shapeDelivery(existing.data), idempotent: true })
    }
  }

  const target = await resolveProjectItemId(admin, input.projectItemId, input.projectId, input.category)
  if (!target.ok) {
    return integrationJson(
      target.projectItemIds
        ? { error: target.error, project_item_ids: target.projectItemIds }
        : { error: target.error },
      target.status,
    )
  }

  const { data, error } = await admin
    .from('project_deliveries')
    .insert({
      project_item_id: target.id,
      quantity: input.quantity,
      delivered_at: deliveryDateOrToday(input.deliveredAt),
      note: input.note,
      source: 'api',
      external_key: input.externalKey,
    })
    .select(DELIVERY_SELECT)
    .single()

  if (error) {
    if (error.code === '23505' && input.externalKey) {
      const replay = await findDeliveryByExternalKey(admin, input.externalKey)
      if (replay.data) {
        return integrationJson({ delivery: shapeDelivery(replay.data), idempotent: true })
      }
    }
    if (error.code === '23503') return integrationJson({ error: 'item_not_found' }, 404)
    console.error('[deliveries] insert', error.message)
    return integrationJson({ error: 'delivery_failed' }, 500)
  }

  return integrationJson({ delivery: shapeDelivery(data), idempotent: false }, 201)
}

async function findDeliveryByExternalKey(admin: Admin, externalKey: string) {
  const { data, error } = await admin
    .from('project_deliveries')
    .select(DELIVERY_SELECT)
    .eq('external_key', externalKey)
    .maybeSingle()
  return { data, error: error?.message ?? null }
}

async function resolveProjectItemId(
  admin: Admin,
  projectItemId: string | null,
  projectId: string | null,
  category: string | null,
): Promise<
  | { ok: true; id: string }
  | { ok: false; error: string; status: number; projectItemIds?: string[] }
> {
  if (projectItemId) {
    const { data, error } = await admin
      .from('project_items')
      .select('id')
      .eq('id', projectItemId)
      .maybeSingle()
    if (error) {
      console.error('[deliveries] item', error.message)
      return { ok: false, error: 'delivery_failed', status: 500 }
    }
    if (!data) return { ok: false, error: 'item_not_found', status: 404 }
    return { ok: true, id: data.id }
  }

  if (!projectId || !category) return { ok: false, error: 'missing_target', status: 400 }

  const { data: items, error } = await admin
    .from('project_items')
    .select(ITEM_LOOKUP_SELECT)
    .eq('project_id', projectId)
  if (error) {
    console.error('[deliveries] items', error.message)
    return { ok: false, error: 'delivery_failed', status: 500 }
  }

  const productIds = [...new Set((items ?? []).map((item) => item.product_id).filter((id): id is string => !!id))]
  const categoryByProduct = new Map<string, string | null>()
  if (productIds.length > 0) {
    const { data: products, error: productError } = await admin
      .from('products')
      .select(PRODUCT_CATEGORY_SELECT)
      .in('id', productIds)
    if (productError) {
      console.error('[deliveries] products', productError.message)
      return { ok: false, error: 'delivery_failed', status: 500 }
    }
    for (const product of products ?? []) categoryByProduct.set(product.id, product.category)
  }

  const matched = matchItemIdsByCategory(
    (items ?? []).map((item) => ({
      id: item.id,
      category: item.product_id ? categoryByProduct.get(item.product_id) ?? null : null,
    })),
    category,
  )

  if (matched.length === 0) return { ok: false, error: 'item_not_found', status: 404 }
  if (matched.length > 1) {
    return { ok: false, error: 'category_ambiguous', status: 409, projectItemIds: matched }
  }
  return { ok: true, id: matched[0] }
}
