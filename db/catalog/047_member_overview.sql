-- ICE catalog 047: 成员经营总览 v1 —— 物流市场汇总的成员读取范围。
--
-- 合同：docs/tasks/member-overview-v1-20261118.md。
-- 背景：
--   * 028/030 的 catalog.read_shipment_market_summary(text) 只允许管理员，输出当前成功
--     快照的票/明细事实（不含金额），正适合成员总览的票数、剩余在途与待核条数；
--   * 本迁移只把入口守卫换成 045 的 require_shipment_read()，并在非管理员时追加
--     s.market = ANY(access_member_markets())；管理员仍返回全部市场，口径不变。
--
-- 不改表、不写业务行；幂等：已带 v_markets 的函数直接跳过。

SET ROLE ice_p0_02_owner;

DO $migration$
DECLARE
  d text;
  n int;
  old_guard constant text := 'PERFORM catalog.require_admin();';
  new_guard constant text := E'PERFORM catalog.require_shipment_read();\n IF catalog.is_admin() THEN v_markets:=NULL; ELSE v_markets:=catalog.access_member_markets(); END IF;';
  decl_anchor constant text := 'v_latest_at timestamptz;';
  scope_anchor constant text := E'    AND CASE WHEN v_unknown_market THEN s.market IS NULL';
  scope_new constant text := E'    AND (v_markets IS NULL OR s.market=ANY(v_markets))\n    AND CASE WHEN v_unknown_market THEN s.market IS NULL';
BEGIN
  d := pg_get_functiondef('catalog.read_shipment_market_summary(text)'::regprocedure);
  IF position('v_markets text[]' in d) > 0 THEN
    RAISE NOTICE '047 already applied';
    RETURN;
  END IF;

  n := (length(d) - length(replace(d, old_guard, ''))) / length(old_guard);
  IF n <> 1 THEN
    RAISE EXCEPTION 'MEMBER_OVERVIEW_GUARD_COUNT:%', n;
  END IF;
  IF position(decl_anchor in d) = 0 THEN
    RAISE EXCEPTION 'MEMBER_OVERVIEW_DECLARE_ANCHOR_MISSING';
  END IF;
  IF position(scope_anchor in d) = 0 THEN
    RAISE EXCEPTION 'MEMBER_OVERVIEW_SCOPE_ANCHOR_MISSING';
  END IF;

  d := replace(d, old_guard, new_guard);
  d := replace(d, decl_anchor, decl_anchor || ' v_markets text[];');
  d := replace(d, scope_anchor, scope_new);
  EXECUTE d;
  RAISE NOTICE '047 applied';
END $migration$;

REVOKE ALL ON FUNCTION catalog.read_shipment_market_summary(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_shipment_market_summary(text) TO ice_p0_02_app_runner;

RESET ROLE;
