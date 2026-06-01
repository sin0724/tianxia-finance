-- 인센티브 공제액 지원
-- monthly_payroll 테이블에 인센티브 공제액 컬럼 추가
ALTER TABLE monthly_payroll
  ADD COLUMN IF NOT EXISTS incentive_deductions INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN monthly_payroll.incentive_deductions IS '인센티브 공제액 (4대보험 등)';
