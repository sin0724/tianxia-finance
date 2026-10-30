-- 025_staff_project_progress.sql
-- 직원 CRM 에 넘기는 프로젝트 진행 피드.
-- 고객, 프로젝트, 담당자 이름, 계약금액, 수금 합계, 구성 항목의 계약 수량만 다룬다.
-- 원가·마진·지출·급여·정산 컬럼은 두지 않는다.
-- 운영 반영은 이 파일을 별도로 적용할 때 한다.

-- ─────────────────────────────────────────────────────────
-- 1. 프로젝트 담당 직원
-- ─────────────────────────────────────────────────────────
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS assignee_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_assignee ON projects (assignee_employee_id);

-- ─────────────────────────────────────────────────────────
-- 2. 직원용 진행 뷰 (프로젝트 1행, 구성 항목은 JSON)
--    security_invoker: 호출자 RLS 를 따른다. 뷰가 RLS 를 우회하지 않는다.
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW staff_project_progress
WITH (security_invoker = true) AS
SELECT
  p.id AS project_id,
  p.client_id,
  c.name AS client_name,
  p.name AS project_name,
  p.status,
  p.contract_date,
  p.assignee_employee_id,
  e.name AS assignee_name,
  p.total_amount AS contract_amount,
  COALESCE(pay.paid_amount, 0) AS paid_amount,
  COALESCE(agg.items, '[]'::jsonb) AS items,
  jsonb_build_object('contracted', COALESCE(agg.contracted, 0)) AS totals
FROM projects p
LEFT JOIN clients c ON c.id = p.client_id
LEFT JOIN employees e ON e.id = p.assignee_employee_id
LEFT JOIN (
  SELECT project_id, COALESCE(SUM(amount), 0) AS paid_amount
  FROM payments
  GROUP BY project_id
) pay ON pay.project_id = p.id
LEFT JOIN (
  SELECT
    pi.project_id,
    jsonb_agg(
      jsonb_build_object(
        'category', pr.category,
        'product_name', pr.name,
        'contracted', pi.quantity
      )
      ORDER BY pi.created_at, pi.id
    ) AS items,
    SUM(pi.quantity)::integer AS contracted
  FROM project_items pi
  LEFT JOIN products pr ON pr.id = pi.product_id
  GROUP BY pi.project_id
) agg ON agg.project_id = p.id;

COMMENT ON VIEW staff_project_progress IS
  '직원용 프로젝트 진행. 담당자 이름, 계약금액, 결제 합계, 계약 수량만 포함한다.';

REVOKE ALL ON staff_project_progress FROM PUBLIC;
REVOKE ALL ON staff_project_progress FROM anon;
GRANT SELECT ON staff_project_progress TO authenticated, service_role;
