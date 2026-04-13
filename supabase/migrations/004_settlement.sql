-- 004_settlement.sql
-- 월별 정산 결과 테이블

CREATE TABLE monthly_settlements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year                    integer NOT NULL,
  month                   integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  total_revenue           numeric(14,2) NOT NULL,
  supply_value            numeric(14,2) NOT NULL,
  total_incentive         numeric(14,2) DEFAULT 0,
  total_product_cost      numeric(14,2) DEFAULT 0,
  gross_profit            numeric(14,2) NOT NULL,
  total_fixed_cost        numeric(14,2) DEFAULT 0,
  total_variable_cost     numeric(14,2) DEFAULT 0,
  total_special_cost      numeric(14,2) DEFAULT 0,
  total_payroll           numeric(14,2) DEFAULT 0,
  operating_profit        numeric(14,2) NOT NULL,
  corporate_tax_reserve   numeric(14,2) DEFAULT 0,
  retained_earnings       numeric(14,2) DEFAULT 0,
  distributable_profit    numeric(14,2) NOT NULL,
  representative_share    numeric(14,2) NOT NULL,
  calculated_at           timestamptz DEFAULT now(),
  UNIQUE(year, month)
);
