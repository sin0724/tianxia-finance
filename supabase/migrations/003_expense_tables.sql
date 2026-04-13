-- 003_expense_tables.sql
-- 지출 관련 테이블

CREATE TABLE monthly_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year            integer NOT NULL,
  month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  category_id     uuid REFERENCES expense_categories(id),
  amount          numeric(12,2) NOT NULL,
  memo            text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_expenses_ym ON monthly_expenses(year, month);

CREATE TABLE monthly_incentives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year            integer NOT NULL,
  month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  employee_id     uuid REFERENCES employees(id),
  amount          numeric(12,2) NOT NULL,
  basis           numeric(12,2),
  memo            text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_incentives_ym ON monthly_incentives(year, month);

CREATE TABLE monthly_payroll (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year            integer NOT NULL,
  month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  employee_id     uuid REFERENCES employees(id),
  base_salary     numeric(12,2) NOT NULL,
  deductions      numeric(12,2) DEFAULT 0,
  net_pay         numeric(12,2) NOT NULL,
  paid_at         date,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_payroll_ym ON monthly_payroll(year, month);
