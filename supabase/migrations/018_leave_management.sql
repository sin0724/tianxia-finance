-- 018_leave_management.sql
-- 연차 관리 — Slack `/연차` 신청 → 관리자 승인 → (선택) 구글 캘린더 반영
--
-- 설계 메모:
--   우리 회사는 5인 미만 사업장이라 근로기준법 제60조(연차유급휴가)가 적용되지 않는다.
--   따라서 "법정 15일"은 의무가 아니라 회사 자율 부여이고, 미사용분에 대한 연차수당도 발생하지 않는다.
--   → 발생 "시점"만 입사일 기준으로 잡고, 발생 "일수"는 leave_grants 에 회사가 직접 적어 넣는다.
--     코드의 계산식(lib/leave/policy.ts)은 grant 행이 없을 때 쓰는 제안값일 뿐이다.

-- ─────────────────────────────────────────────────────────────
-- 1. 직원 ↔ Slack 사용자 매핑
-- ─────────────────────────────────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS slack_user_id TEXT;

COMMENT ON COLUMN employees.slack_user_id IS
  'Slack 사용자 ID (U로 시작). /연차 커맨드 사용자를 직원과 연결한다. 이름이 일치하면 최초 사용 시 자동 매핑된다.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_slack_user_id
  ON employees(slack_user_id) WHERE slack_user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 2. 연차 부여 (입사일 기준 연차연도별)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- 입사일 기준 연차연도: [period_start, period_end] (예: 2025-03-02 ~ 2026-03-01)
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  granted_days  numeric(4,1) NOT NULL DEFAULT 0,
  carried_over  numeric(4,1) NOT NULL DEFAULT 0,  -- 전년도 이월분 (수당이 없으므로 이월/소멸은 회사 재량)
  adjustment    numeric(4,1) NOT NULL DEFAULT 0,  -- 임의 가감 (포상 휴가, 무급 조정 등)
  memo          text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (employee_id, period_start),
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_leave_grants_employee ON leave_grants(employee_id, period_start DESC);

COMMENT ON TABLE leave_grants IS '연차연도별 부여 일수. 총 사용가능 = granted_days + carried_over + adjustment';

-- ─────────────────────────────────────────────────────────────
-- 3. 연차 신청
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type        text NOT NULL DEFAULT 'annual'
                      CHECK (leave_type IN ('annual', 'half_am', 'half_pm', 'sick', 'unpaid', 'special')),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  -- 차감 일수. 주말·공휴일 제외 후 계산되며 반차는 0.5. 신청 시점에 확정 저장한다.
  days              numeric(4,1) NOT NULL,
  reason            text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_via     text NOT NULL DEFAULT 'slack' CHECK (requested_via IN ('slack', 'web')),

  -- Slack 원본 메시지 — 승인/반려 시 같은 메시지를 갱신해 결과를 남긴다
  slack_channel_id  text,
  slack_message_ts  text,

  reviewed_at       timestamptz,
  reviewed_by       text,
  review_memo       text,

  -- 승인 시 생성한 구글 캘린더 이벤트 (반려·취소 시 이 ID로 삭제)
  calendar_event_id text,

  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (days > 0)
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_status  ON leave_requests(status, start_date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests_range   ON leave_requests(start_date, end_date);

COMMENT ON COLUMN leave_requests.days IS
  '차감 일수 — 주말·공휴일 제외, 반차 0.5. 신청 시 확정되며 이후 공휴일 등록이 바뀌어도 소급하지 않는다.';

-- ─────────────────────────────────────────────────────────────
-- 4. 공휴일 (연차 일수 계산에서 제외)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_holidays (
  holiday_date date PRIMARY KEY,
  name         text NOT NULL,
  created_at   timestamptz DEFAULT now()
);

COMMENT ON TABLE company_holidays IS '공휴일·창립기념일 등 휴무일. 연차 일수 계산에서 제외된다.';

-- ─────────────────────────────────────────────────────────────
-- 5. updated_at 트리거
-- ─────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_leave_grants_updated_at ON leave_grants;
CREATE TRIGGER trg_leave_grants_updated_at
  BEFORE UPDATE ON leave_grants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_leave_requests_updated_at ON leave_requests;
CREATE TRIGGER trg_leave_requests_updated_at
  BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 6. RLS — 기존 테이블과 동일 정책 (로그인한 관리자만 접근)
--    Slack 웹훅은 service_role 로 접근하므로 RLS 를 우회한다.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['leave_grants', 'leave_requests', 'company_holidays']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY "authenticated_all" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 7. 2026년 한국 공휴일 시드 (대체공휴일 포함)
-- ─────────────────────────────────────────────────────────────
INSERT INTO company_holidays (holiday_date, name) VALUES
  ('2026-01-01', '신정'),
  ('2026-02-16', '설날 연휴'),
  ('2026-02-17', '설날'),
  ('2026-02-18', '설날 연휴'),
  ('2026-03-01', '삼일절'),
  ('2026-03-02', '삼일절 대체공휴일'),
  ('2026-05-05', '어린이날'),
  ('2026-05-24', '부처님오신날'),
  ('2026-05-25', '부처님오신날 대체공휴일'),
  ('2026-06-03', '지방선거'),
  ('2026-06-06', '현충일'),
  ('2026-08-15', '광복절'),
  ('2026-08-17', '광복절 대체공휴일'),
  ('2026-09-24', '추석 연휴'),
  ('2026-09-25', '추석'),
  ('2026-09-26', '추석 연휴'),
  ('2026-10-03', '개천절'),
  ('2026-10-05', '개천절 대체공휴일'),
  ('2026-10-09', '한글날'),
  ('2026-12-25', '성탄절')
ON CONFLICT (holiday_date) DO NOTHING;
