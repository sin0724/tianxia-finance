-- 005_rls_policies.sql
-- Row Level Security 정책 (인증된 사용자만 접근)

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
    EXECUTE format(
      'CREATE POLICY "authenticated_all" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;
