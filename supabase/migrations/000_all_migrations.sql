-- ============================================================
-- 전체 마이그레이션 (IF NOT EXISTS - 재실행 안전)
-- ============================================================

-- 001: 마스터 테이블

CREATE TABLE IF NOT EXISTS products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  category        text,
  price_vat_incl  numeric(12,2) NOT NULL,
  current_cost    numeric(12,2) NOT NULL,
  active          boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_cost_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid REFERENCES products(id) ON DELETE CASCADE,
  cost            numeric(12,2) NOT NULL,
  effective_from  date NOT NULL,
  note            text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_history_product_date
  ON product_cost_history(product_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  position        text,
  base_salary     numeric(12,2) DEFAULT 0,
  incentive_type  text CHECK (incentive_type IN ('percent', 'fixed')),
  incentive_value numeric(12,2) DEFAULT 0,
  active          boolean DEFAULT true,
  hired_at        date,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  manager         text,
  contact         text,
  memo            text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);

CREATE TABLE IF NOT EXISTS expense_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  parent_type     text NOT NULL CHECK (parent_type IN ('fixed', 'variable', 'special')),
  is_recurring    boolean DEFAULT false,
  is_custom       boolean DEFAULT false,
  active          boolean DEFAULT true,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS representatives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           text UNIQUE NOT NULL,
  share_ratio     numeric(5,2) DEFAULT 50,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key             text PRIMARY KEY,
  value           jsonb NOT NULL,
  updated_at      timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_products_updated_at') THEN
    CREATE TRIGGER trg_products_updated_at
      BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_employees_updated_at') THEN
    CREATE TRIGGER trg_employees_updated_at
      BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_clients_updated_at') THEN
    CREATE TRIGGER trg_clients_updated_at
      BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ============================================================
-- 002: 프로젝트 & 결제 테이블

CREATE TABLE IF NOT EXISTS projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid REFERENCES clients(id),
  name            text NOT NULL,
  total_amount    numeric(12,2) NOT NULL,
  contract_date   date,
  status          text DEFAULT 'ongoing' CHECK (status IN ('ongoing', 'completed', 'cancelled')),
  memo            text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS project_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES projects(id) ON DELETE CASCADE,
  product_id            uuid REFERENCES products(id),
  quantity              integer NOT NULL,
  unit_price_snapshot   numeric(12,2) NOT NULL,
  unit_cost_snapshot    numeric(12,2) NOT NULL,
  created_at            timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id),
  amount          numeric(12,2) NOT NULL,
  payment_date    date NOT NULL,
  payment_type    text CHECK (payment_type IN ('계약금', '중도금', '잔금', '기타')),
  manager         text,
  memo            text,
  source          text DEFAULT 'manual' CHECK (source IN ('slack', 'manual')),
  external_id     text,
  client_name_raw text,
  matched         boolean DEFAULT false,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external ON payments(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_project ON payments(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_updated_at') THEN
    CREATE TRIGGER trg_projects_updated_at
      BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payments_updated_at') THEN
    CREATE TRIGGER trg_payments_updated_at
      BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

CREATE OR REPLACE VIEW project_summary AS
SELECT
  p.id,
  p.name,
  p.client_id,
  c.name AS client_name,
  p.total_amount,
  p.contract_date,
  p.status,
  p.memo,
  p.created_at,
  COALESCE(SUM(pay.amount), 0) AS paid_amount,
  p.total_amount - COALESCE(SUM(pay.amount), 0) AS remaining
FROM projects p
LEFT JOIN clients c ON c.id = p.client_id
LEFT JOIN payments pay ON pay.project_id = p.id
GROUP BY p.id, c.name;

-- ============================================================
-- 003: 지출 테이블

CREATE TABLE IF NOT EXISTS monthly_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year            integer NOT NULL,
  month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  category_id     uuid REFERENCES expense_categories(id),
  amount          numeric(12,2) NOT NULL,
  memo            text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_ym ON monthly_expenses(year, month);

CREATE TABLE IF NOT EXISTS monthly_incentives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year            integer NOT NULL,
  month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  employee_id     uuid REFERENCES employees(id),
  amount          numeric(12,2) NOT NULL,
  basis           numeric(12,2),
  memo            text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incentives_ym ON monthly_incentives(year, month);

CREATE TABLE IF NOT EXISTS monthly_payroll (
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

CREATE INDEX IF NOT EXISTS idx_payroll_ym ON monthly_payroll(year, month);

-- ============================================================
-- 004: 정산 결과 테이블

CREATE TABLE IF NOT EXISTS monthly_settlements (
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

-- ============================================================
-- 005: RLS 정책

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'products', 'product_cost_history', 'employees', 'clients',
    'expense_categories', 'representatives', 'settings',
    'projects', 'project_items', 'payments',
    'monthly_expenses', 'monthly_incentives', 'monthly_payroll',
    'monthly_settlements'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY "authenticated_all" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- 006: 기본 데이터 (중복 방지)

INSERT INTO expense_categories (name, parent_type, is_recurring)
SELECT v.name, v.parent_type::text, v.is_recurring
FROM (VALUES
  ('월세',        'fixed',    true),
  ('공과금',      'fixed',    true),
  ('인터넷',      'fixed',    true),
  ('구독료',      'fixed',    true),
  ('외주비',      'variable', false),
  ('식대',        'variable', false),
  ('교통비',      'variable', false),
  ('기타마케팅비','variable', false)
) AS v(name, parent_type, is_recurring)
WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE name = v.name);

INSERT INTO settings (key, value)
VALUES
  ('vat_rate',                  '0.10'),
  ('corporate_tax_reserve',     '0.10'),
  ('retained_earnings_reserve', '0.08')
ON CONFLICT (key) DO NOTHING;
