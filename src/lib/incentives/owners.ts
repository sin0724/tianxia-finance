/**
 * CRM 담당자명 ↔ 정산 담당자 (화면 · 서버 공용 순수 함수).
 *
 * 정산시트처럼 CRM 결제시트의 담당자 값은 글자 그대로 설정의 CRM 담당자명과 맞춘다.
 * 설정에 없는 값의 줄은 어느 정산표에도 들어가지 않으므로 확인 목록에 모아 보여 주고,
 * 기존 담당자에 연결하거나 새 담당자로 추가하게 한다 (새 사람 · 새 팀 표기가 생길 때).
 */

export interface OwnerManager {
  id: string
  name: string
  crm_names: string[]
  active: boolean
}

export interface OwnerRow {
  row: number
  date: string
  name: string
  owner: string
  amount: number
}

export interface UnmappedOwner {
  /** CRM 담당자 값 그대로 */
  owner: string
  rows: { row: number; date: string; name: string; amount: number }[]
  total: number
  /** 이름이 같은 사용 중 담당자 — 연결할 때 기본으로 고른다 */
  suggestId: string | null
  /** 이 값을 CRM 담당자명으로 가진 쉬는 담당자 — 설정에서 '사용'을 켜야 정산된다 */
  inactiveName: string | null
  /** 새 담당자로 만들 때 쓸 이름. 같은 이름의 담당자가 이미 있으면 null */
  newName: string | null
}

/** CRM 담당자 값의 사람 이름: "홍길동 0팀" → "홍길동" */
export function personOf(owner: string): string {
  return owner.trim().split(/\s+/)[0] ?? ''
}

/**
 * Slack /결제 담당자 목록 — 사용 중인 담당자의 Slack 결제 담당자 이름을 설정 순서대로 (겹치면 한 번).
 * 여기 적은 이름은 저장할 때 그 담당자의 CRM 담당자명에도 들어가므로, /결제로 등록한 줄은 그 담당자 정산에 들어간다.
 */
export function slackOptions(managers: { name: string; sort_order: number; active: boolean; slack_names?: string[] | null }[]): string[] {
  const ordered = managers.filter((m) => m.active).sort((a, b) => a.sort_order - b.sort_order)
  return [...new Set(ordered.flatMap((m) => (m.slack_names ?? []).map((s) => s.trim()).filter(Boolean)))]
}

/** 두 담당자에 함께 들어 있는 CRM 담당자명 — 있으면 같은 CRM 줄이 두 번 정산된다 */
export function duplicateCrmNames(managers: Pick<OwnerManager, 'name' | 'crm_names'>[]): { crmName: string; managers: string[] }[] {
  const holders = new Map<string, string[]>()
  for (const m of managers) {
    for (const n of new Set(m.crm_names.map((x) => x.trim()).filter(Boolean))) {
      holders.set(n, [...(holders.get(n) ?? []), m.name])
    }
  }
  return [...holders].filter(([, ms]) => ms.length > 1).map(([crmName, ms]) => ({ crmName, managers: ms }))
}

/** 이 달 CRM 줄 중 담당자 값이 사용 중인 담당자의 CRM 담당자명에 없는 것 — 담당자 값별로 묶는다 */
export function unmappedOwners(rows: OwnerRow[], managers: OwnerManager[], year: number, month: number): UnmappedOwner[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  const active = managers.filter((m) => m.active)
  const mapped = new Set(active.flatMap((m) => m.crm_names))
  const names = new Set(managers.map((m) => m.name))

  const heldByInactive = new Map<string, string>()
  for (const m of managers) if (!m.active) for (const n of m.crm_names) heldByInactive.set(n, m.name)

  // 사람 이름 → 담당자: 정산표 이름이 먼저, 그다음 CRM 담당자명의 앞 이름
  const byPerson = new Map<string, string>()
  for (const m of active) byPerson.set(personOf(m.name), m.id)
  for (const m of active) for (const n of m.crm_names) if (!byPerson.has(personOf(n))) byPerson.set(personOf(n), m.id)

  const groups = new Map<string, UnmappedOwner>()
  for (const r of rows) {
    if (!r.date.startsWith(prefix) || !r.owner || mapped.has(r.owner)) continue
    let g = groups.get(r.owner)
    if (!g) {
      const person = personOf(r.owner)
      g = {
        owner: r.owner, rows: [], total: 0,
        suggestId: byPerson.get(person) ?? null,
        inactiveName: heldByInactive.get(r.owner) ?? null,
        newName: person && !names.has(person) ? person : null,
      }
      groups.set(r.owner, g)
    }
    g.rows.push({ row: r.row, date: r.date, name: r.name, amount: r.amount })
    g.total += r.amount
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => a.row - b.row) }))
    .sort((a, b) => a.rows[0].row - b.rows[0].row)
}
