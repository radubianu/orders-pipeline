// Seed example bundle + item-map rows for local/manual testing. Adjust
// SKUs and QBO item IDs to match your own sandbox company's Item list.
import "../src/env";
import { pool } from "../src/db/pool";

async function main() {
  // A "coffee starter kit" bundle: 1 mug + 2 bags of coffee + 1 coaster,
  // decomposed from a single Shopify line item into three QBO lines.
  await pool.query(
    `INSERT INTO bundle_components (bundle_sku, component_sku, qty_per_bundle, reference_price)
     VALUES
       ('BUNDLE-COFFEE-KIT', 'SKU-MUG',        1, 12.00),
       ('BUNDLE-COFFEE-KIT', 'SKU-COFFEE-BAG', 2, 9.50),
       ('BUNDLE-COFFEE-KIT', 'SKU-COASTER',    1, 4.00)
     ON CONFLICT (bundle_sku, component_sku) DO NOTHING`
  );

  await pool.query(
    `INSERT INTO sku_qbo_item_map (sku, qbo_item_id)
     VALUES
       ('SKU-MUG',        '19'),
       ('SKU-COFFEE-BAG', '20'),
       ('SKU-COASTER',    '21'),
       ('SKU-TSHIRT',     '22')
     ON CONFLICT (sku) DO UPDATE SET
       qbo_item_id = EXCLUDED.qbo_item_id`
  );

  console.log("seeded bundle_components and sku_qbo_item_map");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
