-- 025_payroll_statements.sql
-- 급여를 앱에서 계산하지 않고 세무사 명세서 금액을 그대로 쓴다.
-- 직원 메모는 직원 관리로 모은다.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS memo text;

ALTER TABLE monthly_payroll
  ADD COLUMN IF NOT EXISTS other_deductions numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS statement_kind text CHECK (statement_kind IN ('business', 'insured')),
  ADD COLUMN IF NOT EXISTS statement_file text;

COMMENT ON COLUMN employees.memo IS '직원 메모. 계산에는 쓰지 않는다';
COMMENT ON COLUMN monthly_payroll.other_deductions IS '세금 외 공제 — 근로자부담 4대보험 등. 명세서 공제합계에서 소득세·지방소득세를 뺀 값';
COMMENT ON COLUMN monthly_payroll.statement_kind IS '금액의 출처 명세서: business(3.3% 사업소득) / insured(4대보험 급여). 비어 있으면 명세서 없이 입력된 값';
COMMENT ON COLUMN monthly_payroll.statement_file IS '금액을 반영한 명세서 파일 이름';
