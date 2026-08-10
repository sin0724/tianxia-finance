-- 016_payroll_workflow.sql
-- 급여 워크플로 재정비 — 사업소득지급대장(3.3% 원천징수) 기준
--
-- 실제 업무 흐름을 그대로 데이터 모델로 옮긴다.
--   ① 산정   회사가 세전 지급액을 정한다 (정직원 기본급 / 알바 시급×시간+주휴 / 인센티브)
--   ② 제출   사업소득지급대장 양식으로 세무사에게 넘긴다
--   ③ 확정   세무사가 원천징수까지 계산한 대장을 회신 → 세금·세후액을 받아 적는다
--   ④ 지급   차인지급액을 입금하고 지급일을 남긴다
--
-- 앱은 세금을 "결정"하지 않는다. 3.3% 계산은 검산용 제안값일 뿐이고
-- 진실은 항상 ③에서 세무사가 준 값이다.

-- ── 직원 마스터 ──────────────────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS insured       boolean DEFAULT false,  -- 4대보험 가입 여부 (회사부담분 발생)
  ADD COLUMN IF NOT EXISTS sort_order    integer,                -- 사업소득지급대장 NO 순서
  ADD COLUMN IF NOT EXISTS terminated_at date;                   -- 퇴사일 (active=false 사유 구분용)

COMMENT ON COLUMN employees.insured    IS '4대보험 가입 여부 — true인 직원만 회사부담분 입력칸이 열린다';
COMMENT ON COLUMN employees.sort_order IS '사업소득지급대장 출력 순서 (NULL이면 이름 순)';

-- 주민등록번호는 저장하지 않는다.
-- 대장 양식에 C열이 있으나 실제 제출본에서도 비워서 내보내고 있어(세무사가 이미 보유),
-- 민감정보를 앱 DB에 남길 이유가 없다. 대장 출력 시 C열은 빈 칸으로 생성된다.

-- ── 월별 급여 ────────────────────────────────────────────────
ALTER TABLE monthly_payroll
  ADD COLUMN IF NOT EXISTS status               text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS base_income_tax      numeric(12,2) DEFAULT 0,  -- 기본급분 소득세 (3%)
  ADD COLUMN IF NOT EXISTS base_local_tax       numeric(12,2) DEFAULT 0,  -- 기본급분 지방소득세 (소득세의 10%)
  ADD COLUMN IF NOT EXISTS incentive_income_tax numeric(12,2) DEFAULT 0,  -- 인센티브분 소득세
  ADD COLUMN IF NOT EXISTS incentive_local_tax  numeric(12,2) DEFAULT 0,  -- 인센티브분 지방소득세
  ADD COLUMN IF NOT EXISTS employer_insurance   numeric(12,2) DEFAULT 0,  -- 4대보험 회사부담분 (실제 회사 지출)
  ADD COLUMN IF NOT EXISTS submitted_at         date,
  ADD COLUMN IF NOT EXISTS confirmed_at         date;

COMMENT ON COLUMN monthly_payroll.base_salary          IS '기본급 — 세전(원천징수 전) 지급액. 알바는 시급×시간+주휴 합계';
COMMENT ON COLUMN monthly_payroll.employer_insurance   IS '4대보험 회사부담분 — 원천징수와 별개로 회사에서 나가는 돈. 영업이익에서 차감된다';
-- (incentive_deductions 는 017에서 incentive_income_tax / incentive_local_tax 로 이관되며 폐기된다)
COMMENT ON COLUMN monthly_payroll.deductions           IS '(파생) 기본급분 원천징수 합계 = base_income_tax + base_local_tax';
COMMENT ON COLUMN monthly_payroll.net_pay              IS '(파생) 기본급 차인지급액 = base_salary - deductions';

DO $$ BEGIN
  ALTER TABLE monthly_payroll
    ADD CONSTRAINT monthly_payroll_status_check
    CHECK (status IN ('draft', 'submitted', 'confirmed', 'paid'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 한 직원 / 한 달 = 한 행. 기존 중복행은 최신 것만 남긴다.
DELETE FROM monthly_payroll a
USING monthly_payroll b
WHERE a.employee_id IS NOT NULL
  AND a.employee_id = b.employee_id
  AND a.year = b.year
  AND a.month = b.month
  AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.ctid < b.ctid));

-- 부분 인덱스로 만들면 ON CONFLICT 추론이 안 되므로 일반 제약으로 건다.
-- (employee_id가 NULL인 행은 NULL끼리 서로 다르게 취급되어 여러 개 남을 수 있다)
DO $$ BEGIN
  ALTER TABLE monthly_payroll
    ADD CONSTRAINT monthly_payroll_emp_month_unique UNIQUE (year, month, employee_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

-- ── 기존 데이터 backfill ─────────────────────────────────────
-- 그동안 base_salary에는 세전, net_pay에는 세후, deductions에는 세무사가 준 공제액을
-- 넣어왔다. 사업소득 3.3%는 지방소득세가 소득세의 10%이므로 총공제액 ÷ 1.1 로 되돌린다.
-- (4대보험 가입자의 과거 행은 공제액에 보험료가 섞여 있을 수 있어 근사값이며,
--  해당 월을 ③ 확정 단계에서 다시 저장하면 정확한 값으로 덮어쓰인다.)
UPDATE monthly_payroll
SET base_income_tax = floor(deductions / 1.1 / 10) * 10,
    base_local_tax  = deductions - floor(deductions / 1.1 / 10) * 10
WHERE deductions > 0
  AND COALESCE(base_income_tax, 0) = 0
  AND COALESCE(base_local_tax, 0) = 0;

-- 이미 지급일이 있는 과거 행은 지급완료, 나머지는 확정 상태로 본다.
UPDATE monthly_payroll
SET status = CASE WHEN paid_at IS NOT NULL THEN 'paid' ELSE 'confirmed' END
WHERE status = 'draft'
  AND (paid_at IS NOT NULL OR deductions > 0);

-- ── 정산 결과 ────────────────────────────────────────────────
-- 4대보험 회사부담분을 별도 항목으로 잡는다. 그동안 월별 지출에 손으로 넣어왔던
-- 금액이 급여 화면에서 직원별로 집계돼 올라온다. (이중계상 방지 안내는 앱에서 처리)
ALTER TABLE monthly_settlements
  ADD COLUMN IF NOT EXISTS total_employer_insurance numeric(14,2) DEFAULT 0;

COMMENT ON COLUMN monthly_settlements.total_payroll             IS '급여 합계 — 세전 기본급 기준 (원천징수 전)';
COMMENT ON COLUMN monthly_settlements.total_employer_insurance  IS '4대보험 회사부담 합계 — 영업이익에서 차감';
