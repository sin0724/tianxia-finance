-- 020_refund_to_project.sql
-- 환불 건을 기존 프로젝트에 자동 반영
--
-- 환불은 "결제 추가"에서 음수 금액으로 넣는다 (Slack /결제·시트 동기화는 0 이하를 거른다).
-- 그런데 저장 RPC(add_payment_with_auto_project)가 환불을 몰라서 두 가지가 어긋났다.
--
--   ① 상호명만 넣으면 "잔여가 남은 프로젝트"를 찾는데, 완납된 프로젝트는 잔여가 없으니
--      매칭에서 빠지고 → 계약금액이 마이너스인 새 프로젝트가 생겼다.
--   ② 프로젝트를 직접 골라도 projects.total_amount 는 그대로라 입금완료만 줄어들었다.
--      계약 1,000,000 / 입금 1,000,000 에 환불 -300,000 이 붙으면 "입금 700,000 · 잔여 300,000"
--      으로 보이고, 다음 동기화 때 같은 클라이언트의 새 결제가 이 잔여에 합쳐졌다.
--
-- 그래서 그동안 사람이 프로젝트 계약금액을 손으로 고쳐 왔다. 이번부터:
--
--   - 환불(확정 상태의 음수 결제)이 프로젝트에 연결되면 계약금액에서 그만큼 뺀다.
--     연결이 풀리거나 삭제되면 되돌린다. 결제를 어디서 고치든(추가·수정·연결·삭제)
--     같은 규칙이 적용되도록 payments 트리거로 둔다.
--     → 015 의 "누적 결제가 계약금액을 넘으면 총액을 올린다"와 대칭.
--   - 받았던 돈이 전부 돌아가면(순입금 ≤ 0) 프로젝트를 취소 처리한다.
--     취소된 프로젝트는 매칭 후보에서 빠지므로 이후 결제는 새 프로젝트로 간다.
--   - RPC 는 환불이면 클라이언트·프로젝트를 새로 만들지 않고, 그 상호명의 프로젝트 중
--     확정 입금이 있는 가장 최근 것에 붙인다. 못 찾으면 미연결로 두고 사람이 잇는다.
--
-- 주의: 이미 손으로 계약금액을 줄여둔 예전 환불 건을 다시 연결·수정하면 한 번 더
-- 차감된다. 예전 건은 건드리지 않는 게 안전하다.

-- ─────────────────────────────────────────────────────────
-- 1. 환불이 계약금액에 미치는 영향 — 확정 상태의 음수 결제만 해당
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refund_effect(p_amount numeric, p_status text, p_project_id uuid)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_project_id IS NOT NULL AND p_status = 'confirmed' AND p_amount < 0 THEN p_amount
    ELSE 0
  END
$$;

-- ─────────────────────────────────────────────────────────
-- 2. 프로젝트 계약금액에 환불 증감 적용 (+ 전액 환불이면 취소 처리)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION apply_refund_delta(p_project_id uuid, p_delta numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_net_paid numeric;
  v_had_income boolean;
BEGIN
  IF p_project_id IS NULL OR p_delta = 0 THEN
    RETURN;
  END IF;

  UPDATE projects
  SET total_amount = greatest(total_amount + p_delta, 0)
  WHERE id = p_project_id;

  -- 전액 환불 판정: 받은 돈이 있었는데 순입금이 0 이하로 떨어졌다
  IF p_delta < 0 THEN
    SELECT coalesce(sum(amount), 0), bool_or(amount > 0)
    INTO v_net_paid, v_had_income
    FROM payments
    WHERE project_id = p_project_id AND status = 'confirmed';

    IF coalesce(v_had_income, false) AND v_net_paid <= 0.005 THEN
      UPDATE projects SET status = 'cancelled'
      WHERE id = p_project_id AND status <> 'cancelled';
    END IF;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────
-- 3. payments 트리거 — 추가·수정·연결·삭제 어디서든 같은 규칙
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_payments_refund_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old numeric := 0;
  v_new numeric := 0;
  v_old_pid uuid;
  v_new_pid uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old := refund_effect(OLD.amount, OLD.status, OLD.project_id);
    v_old_pid := OLD.project_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new := refund_effect(NEW.amount, NEW.status, NEW.project_id);
    v_new_pid := NEW.project_id;
  END IF;

  IF v_old_pid IS NOT DISTINCT FROM v_new_pid THEN
    -- 같은 프로젝트: 금액·상태 변화분만 반영
    PERFORM apply_refund_delta(v_new_pid, v_new - v_old);
  ELSE
    -- 프로젝트가 바뀜: 이전 프로젝트는 원복, 새 프로젝트에 적용
    PERFORM apply_refund_delta(v_old_pid, -v_old);
    PERFORM apply_refund_delta(v_new_pid, v_new);
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_payments_refund_sync ON payments;
CREATE TRIGGER trg_payments_refund_sync
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_payments_refund_sync();

-- ─────────────────────────────────────────────────────────
-- 4. RPC 재정의: 환불이면 새로 만들지 않고 기존 프로젝트에 붙인다
--    (양수 결제 경로는 015 그대로)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION add_payment_with_auto_project(
  p_amount numeric,
  p_payment_date date,
  p_payment_type text DEFAULT NULL,
  p_manager text DEFAULT NULL,
  p_memo text DEFAULT NULL,
  p_client_name text DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_status text DEFAULT 'confirmed'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_client_id uuid;
  v_project_id uuid := p_project_id;
  v_prior_count int := 0;
  v_created_project boolean := false;
  v_payment_id uuid;
  v_name text := NULLIF(trim(coalesce(p_client_name, '')), '');
  v_is_refund boolean := p_amount < 0;
  v_proj projects%ROWTYPE;
BEGIN
  IF v_is_refund THEN
    -- 환불: 클라이언트·프로젝트를 새로 만들지 않는다.
    -- 상호명의 프로젝트 중 확정 입금이 있는 가장 최근 것에 붙인다.
    IF v_project_id IS NULL AND v_name IS NOT NULL THEN
      SELECT id INTO v_client_id FROM clients WHERE lower(name) = lower(v_name) LIMIT 1;
      IF v_client_id IS NOT NULL THEN
        SELECT p.id INTO v_project_id
        FROM projects p
        WHERE p.client_id = v_client_id
          AND p.status IN ('ongoing', 'completed')
          AND (SELECT coalesce(sum(amount), 0) FROM payments
               WHERE project_id = p.id AND status = 'confirmed') > 0
        ORDER BY p.created_at DESC
        LIMIT 1;
      END IF;
    END IF;

  ELSIF v_project_id IS NULL AND v_name IS NOT NULL THEN
    -- 클라이언트 찾기 또는 생성
    SELECT id INTO v_client_id FROM clients WHERE lower(name) = lower(v_name) LIMIT 1;
    IF v_client_id IS NULL THEN
      INSERT INTO clients (name, manager) VALUES (v_name, NULLIF(trim(coalesce(p_manager, '')), ''))
      RETURNING id INTO v_client_id;
    END IF;

    SELECT count(*) INTO v_prior_count
    FROM projects WHERE client_id = v_client_id AND status <> 'cancelled';

    -- 잔여 결제가 남은 프로젝트 찾기 (진행중 우선 → 완료)
    SELECT p.id INTO v_project_id
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(amount), 0) AS paid FROM payments WHERE project_id = p.id
    ) pay ON true
    WHERE p.client_id = v_client_id
      AND p.status IN ('ongoing', 'completed')
      AND pay.paid < p.total_amount
    ORDER BY CASE p.status WHEN 'ongoing' THEN 0 ELSE 1 END, p.created_at DESC
    LIMIT 1;

    IF v_project_id IS NULL THEN
      INSERT INTO projects (client_id, name, total_amount, contract_date, status, memo)
      VALUES (
        v_client_id,
        CASE WHEN v_prior_count > 0 THEN v_name || ' (재계약 ' || v_prior_count || '차)' ELSE v_name END,
        p_amount, p_payment_date, 'ongoing',
        CASE WHEN v_prior_count > 0 THEN '재계약 (자동 생성)' ELSE NULL END
      ) RETURNING id INTO v_project_id;
      v_created_project := true;
    END IF;
  END IF;

  -- 환불이면 이 INSERT 로 trg_payments_refund_sync 가 계약금액을 차감한다
  INSERT INTO payments (
    project_id, amount, payment_date, payment_type, manager,
    memo, source, client_name_raw, matched, status
  ) VALUES (
    v_project_id, p_amount, p_payment_date,
    NULLIF(trim(coalesce(p_payment_type, '')), ''),
    NULLIF(trim(coalesce(p_manager, '')), ''),
    NULLIF(trim(coalesce(p_memo, '')), ''),
    'manual', v_name,
    (v_project_id IS NOT NULL),
    coalesce(NULLIF(p_status, ''), 'confirmed')
  ) RETURNING id INTO v_payment_id;

  IF v_is_refund AND v_project_id IS NOT NULL THEN
    -- 트리거 반영 후 상태를 읽어 화면 안내에 쓴다
    SELECT * INTO v_proj FROM projects WHERE id = v_project_id;
  END IF;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'project_id', v_project_id,
    'created_project', v_created_project,
    'refund', v_is_refund,
    'project_name', v_proj.name,
    'project_total', v_proj.total_amount,
    'project_status', v_proj.status
  );
END $$;
