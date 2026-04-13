-- 006_seed_data.sql
-- 기본 카테고리 및 시스템 설정 초기 데이터

-- 지출 카테고리 기본값
INSERT INTO expense_categories (name, parent_type, is_recurring) VALUES
  -- 고정비 (매월 반복)
  ('월세',       'fixed',    true),
  ('공과금',     'fixed',    true),
  ('인터넷',     'fixed',    true),
  ('구독료',     'fixed',    true),
  -- 변동비
  ('외주비',     'variable', false),
  ('식대',       'variable', false),
  ('교통비',     'variable', false),
  ('기타마케팅비','variable', false);

-- 시스템 설정 기본값
INSERT INTO settings (key, value) VALUES
  ('vat_rate',                  '0.10'),
  ('corporate_tax_reserve',     '0.10'),
  ('retained_earnings_reserve', '0.08');
