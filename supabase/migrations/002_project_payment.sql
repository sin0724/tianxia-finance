-- 002_project_payment.sql
-- 프로젝트 & 결제 테이블

CREATE TABLE projects (
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

CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_status ON projects(status);

CREATE TABLE project_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES projects(id) ON DELETE CASCADE,
  product_id            uuid REFERENCES products(id),
  quantity              integer NOT NULL,
  unit_price_snapshot   numeric(12,2) NOT NULL,
  unit_cost_snapshot    numeric(12,2) NOT NULL,
  created_at            timestamptz DEFAULT now()
);

CREATE TABLE payments (
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

CREATE UNIQUE INDEX idx_payments_external ON payments(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_payments_project ON payments(project_id);
CREATE INDEX idx_payments_date ON payments(payment_date);

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 프로젝트 잔금 계산 뷰
CREATE VIEW project_summary AS
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
