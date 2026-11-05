-- 026_payroll_cash_pay.sql
-- 세무사 명세서에 없는 현금 지급을 급여 비용으로 넣는다. 세금 없이 지급액이 그대로 비용이다.

ALTER TABLE monthly_payroll DROP CONSTRAINT IF EXISTS monthly_payroll_statement_kind_check;
ALTER TABLE monthly_payroll
  ADD CONSTRAINT monthly_payroll_statement_kind_check
  CHECK (statement_kind IN ('business', 'insured', 'cash'));

COMMENT ON COLUMN monthly_payroll.statement_kind IS '금액의 출처: business(3.3% 사업소득) / insured(4대보험 급여) / cash(명세서에 없는 현금 지급). 비어 있으면 명세서 없이 입력된 값';
