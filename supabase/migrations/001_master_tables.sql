-- 001_master_tables.sql
-- 마스터 데이터 테이블

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  category        text,  -- 'Dcard' | 'PTT' | 'Threads' | 'PR' | 'KOC' | 'KOL'
  price_vat_incl  numeric(12,2) NOT NULL,
  current_cost    numeric(12,2) NOT NULL,
  active          boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE product_cost_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid REFERENCES products(id) ON DELETE CASCADE,
  cost            numeric(12,2) NOT NULL,
  effective_from  date NOT NULL,
  note            text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_cost_history_product_date
  ON product_cost_history(product_id, effective_from DESC);

CREATE TABLE employees (
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

CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  manager         text,
  contact         text,
  memo            text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_clients_name ON clients(name);

CREATE TABLE expense_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  parent_type     text NOT NULL CHECK (parent_type IN ('fixed', 'variable', 'special')),
  is_recurring    boolean DEFAULT false,
  is_custom       boolean DEFAULT false,
  active          boolean DEFAULT true,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE representatives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           text UNIQUE NOT NULL,
  share_ratio     numeric(5,2) DEFAULT 50,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE settings (
  key             text PRIMARY KEY,
  value           jsonb NOT NULL,
  updated_at      timestamptz DEFAULT now()
);

-- updated_at 자동 갱신 함수
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
