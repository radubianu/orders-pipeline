-- qbo_item_name was never read by application code (worker.ts only looks
-- up qbo_item_id) -- dropping it rather than carrying an unused column.
ALTER TABLE sku_qbo_item_map DROP COLUMN qbo_item_name;
