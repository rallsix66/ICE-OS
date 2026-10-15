-- DELIVERY-02: 来源库存 quantity 仅经 sync runner 写入；app runner 不得直接 UPDATE inventory。

REVOKE UPDATE ON public.inventory FROM ice_p0_02_app_runner;

DROP POLICY IF EXISTS operator_update_inventory_quantity ON public.inventory;
DROP POLICY IF EXISTS admin_all_inventory ON public.inventory;

CREATE POLICY admin_select_inventory ON public.inventory
  FOR SELECT
  USING (public.get_user_role() = 'admin'::text);
