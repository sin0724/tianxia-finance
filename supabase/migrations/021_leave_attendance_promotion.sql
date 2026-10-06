-- 021_leave_attendance_promotion.sql
-- 연차 발생을 출근율 기준으로 바꾸고, 미사용 연차 사용 촉진(근로기준법 제61조)을 기록한다.
--
-- 018 에서는 "5인 미만이라 제60조 미적용 → 15일은 회사 자율"로 설계했으나,
-- 이번부터 회사 규정을 법정 기준에 맞춘다.
--
--   ① 1년 미만   입사일 기준 1개월 개근 시 1일 (최대 11일)
--   ② 1년 이상   직전 연차연도 출근율 80% 이상이면 15일 + 근속 가산
--                (최초 1년을 초과하는 계속근로 매 2년마다 1일, 총 25일 한도)
--                80% 미만이면 직전 연도에 개근한 달마다 1일
--   ③ 미사용 연차는 연차연도가 끝나면 소멸 — 이월은 leave_grants.carried_over 로 수동 지정할 때만
--   ④ 소멸 6개월 전 1차 촉진(미사용 일수 통보 + 사용 계획 제출 요청), 2개월 전 2차 촉진
--
-- 개근/출근율을 판정하려면 결근 기록이 있어야 한다. 정직원은 급여가 월급이라
-- monthly_payroll.absent_days(알바 주휴용, 달력 월 단위)로는 입사일 기준 월을 끊을 수 없으므로
-- 날짜 단위 결근 기록 테이블을 따로 둔다. 기록이 없으면 개근으로 본다.

-- ─────────────────────────────────────────────────────────────
-- 1. 결근 기록
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_absences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  absence_date  date NOT NULL,
  -- 반일 결근은 0.5. 출근율 계산에서 소정근로일에서 이만큼 빠진다
  days          numeric(2,1) NOT NULL DEFAULT 1 CHECK (days IN (0.5, 1)),
  memo          text,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (employee_id, absence_date)
);

CREATE INDEX IF NOT EXISTS idx_leave_absences_employee ON leave_absences(employee_id, absence_date);

COMMENT ON TABLE leave_absences IS
  '정직원 결근 기록. 연차 발생(1개월 개근·연 80% 출근율) 판정에만 쓴다. '
  '승인된 연차·병가·특별휴가·공휴일은 결근이 아니므로 넣지 않는다.';

-- ─────────────────────────────────────────────────────────────
-- 2. 연차 사용 촉진 이력
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_promotions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  -- 1 = 1차(소멸 6개월 전), 2 = 2차(소멸 2개월 전)
  stage             smallint NOT NULL CHECK (stage IN (1, 2)),
  -- 통보 당시 미사용 일수 — 나중에 분쟁이 생기면 이 값이 근거가 된다
  unused_days       numeric(4,1) NOT NULL,
  notified_at       timestamptz NOT NULL DEFAULT now(),
  -- Slack DM 전송 성공 여부 (토큰 없음·계정 미연결이면 false → 관리자가 서면 통보해야 한다)
  dm_sent           boolean NOT NULL DEFAULT false,
  -- 1차: 직원이 제출한 사용 계획
  plan_text         text,
  plan_submitted_at timestamptz,
  created_at        timestamptz DEFAULT now(),
  UNIQUE (employee_id, period_start, stage)
);

CREATE INDEX IF NOT EXISTS idx_leave_promotions_period ON leave_promotions(period_end, stage);

COMMENT ON TABLE leave_promotions IS
  '연차 사용 촉진 통보 이력 (근로기준법 제61조). 같은 연차연도·차수에는 한 번만 보낸다.';

-- ─────────────────────────────────────────────────────────────
-- 3. RLS — 기존 테이블과 동일 정책
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['leave_absences', 'leave_promotions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY "authenticated_all" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;
