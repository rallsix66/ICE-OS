-- DELIVERY-03: partial_warehouse_shipment 写入 partial_warehoused 轨迹，须与 CHECK 一致。

ALTER TABLE public.tracking_event DROP CONSTRAINT IF EXISTS tracking_event_status_check;

ALTER TABLE public.tracking_event ADD CONSTRAINT tracking_event_status_check
  CHECK (
    status = ANY (
      ARRAY[
        'booking'::text,
        'loading'::text,
        'departed'::text,
        'arrived'::text,
        'customs'::text,
        'warehoused'::text,
        'partial_warehoused'::text
      ]
    )
  );
