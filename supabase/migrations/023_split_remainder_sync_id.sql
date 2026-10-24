-- ─────────────────────────────────────────────────────────
-- 023. 부분 입금 잔여분에 시트 동기화 ID 연결
--
-- 문제: 수금 관리에서 일부만 입금 확정하면 원래 건(시트 M열 ID 보유)은 확정되고
--       차액은 external_id 없는 새 건으로 남았다. 이후 시트에서 그 행을 '입금완료'로 바꿔도
--       sync-sheets 는 원래 건만 찾고(이미 확정이라 변화 없음) 잔여분은 영영 수금 예정에 남았다.
-- 해결: 잔여분에 `{원래 시트 ID}#{접미사}` 를 부여해 sync-sheets 가 같은 시트 행으로 묶어 처리한다.
--       이미 끊긴 예전 잔여분은 sync-sheets 가 실행될 때 프로젝트·금액 기준으로 다시 연결한다.
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION confirm_pending_payment(
  p_payment_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_project_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_orig payments%ROWTYPE;
  v_remainder numeric;
BEGIN
  SELECT * INTO v_orig FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '결제 내역을 찾을 수 없습니다';
  END IF;

  UPDATE payments SET
    amount       = p_amount,
    payment_date = p_payment_date,
    project_id   = p_project_id,
    matched      = (p_project_id IS NOT NULL),
    status       = 'confirmed'
  WHERE id = p_payment_id;

  -- 부분 입금 — 차액을 원래 상태의 수금 예정 건으로 남긴다
  v_remainder := v_orig.amount - p_amount;
  IF v_remainder > 0.01 THEN
    INSERT INTO payments (
      project_id, amount, payment_date, payment_type, manager,
      memo, source, client_name_raw, matched, status, external_id
    ) VALUES (
      p_project_id, v_remainder, v_orig.payment_date, v_orig.payment_type, v_orig.manager,
      v_orig.memo, v_orig.source, v_orig.client_name_raw,
      (p_project_id IS NOT NULL),
      CASE WHEN v_orig.status = 'confirmed' THEN 'balance_due' ELSE v_orig.status END,
      -- 시트 행에서 온 건이면 같은 시트 ID 아래 잔여분으로 묶는다 (잔여분을 다시 쪼개도 앞부분은 유지)
      CASE WHEN v_orig.external_id LIKE 'tx\_%'
        THEN split_part(v_orig.external_id, '#', 1) || '#' || substr(md5(random()::text || clock_timestamp()::text), 1, 8)
        ELSE NULL END
    );
  END IF;

  RETURN jsonb_build_object('remainder', GREATEST(v_remainder, 0));
END $$;
