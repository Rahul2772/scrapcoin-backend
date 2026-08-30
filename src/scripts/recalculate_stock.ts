/**
 * One-time script to recalculate correct stock_qty for all materials
 * based on actual buy (erp_purchase_receipts) and sell (erp_transactions) history.
 *
 * Correct formula:  stock_qty = SUM(receipts.weight) - SUM(transactions.weight)
 *
 * Run with:  npx tsx src/scripts/recalculate_stock.ts
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function run() {
  console.log("Fetching materials...");
  const { data: materials, error: matErr } = await supabase
    .from("erp_materials")
    .select("id, name, stock_qty")
    .eq("is_active", true);

  if (matErr) { console.error("Materials error:", matErr.message); process.exit(1); }

  console.log("Fetching purchase receipts (buy from customers)...");
  const { data: receipts, error: rErr } = await supabase
    .from("erp_purchase_receipts")
    .select("material_id, weight");

  if (rErr) { console.error("Receipts error:", rErr.message); process.exit(1); }

  console.log("Fetching scale transactions (sell to recyclers)...");
  const { data: transactions, error: tErr } = await supabase
    .from("erp_transactions")
    .select("material_id, weight");

  if (tErr) { console.error("Transactions error:", tErr.message); process.exit(1); }

  // Aggregate bought weight per material
  const boughtMap: Record<string, number> = {};
  (receipts || []).forEach((r) => {
    boughtMap[r.material_id] = (boughtMap[r.material_id] || 0) + Number(r.weight);
  });

  // Aggregate sold weight per material
  const soldMap: Record<string, number> = {};
  (transactions || []).forEach((t) => {
    soldMap[t.material_id] = (soldMap[t.material_id] || 0) + Number(t.weight);
  });

  console.log("\n=== Stock Recalculation ===\n");
  let updated = 0;

  for (const mat of materials || []) {
    const bought = boughtMap[mat.id] || 0;
    const sold = soldMap[mat.id] || 0;
    const correct_stock = Math.max(0, bought - sold);
    const old_stock = Number(mat.stock_qty);

    const { error: updateErr } = await supabase
      .from("erp_materials")
      .update({ stock_qty: correct_stock, updated_at: new Date().toISOString() })
      .eq("id", mat.id);

    if (updateErr) {
      console.error(`  ERROR updating ${mat.name}:`, updateErr.message);
    } else {
      console.log(
        `  ${mat.name.padEnd(25)} | old: ${old_stock.toFixed(2).padStart(8)} kg  →  new: ${correct_stock.toFixed(2).padStart(8)} kg  (bought: ${bought.toFixed(2)}, sold: ${sold.toFixed(2)})`
      );
      updated++;
    }
  }

  console.log(`\n✅ Done — updated ${updated} / ${(materials || []).length} materials.`);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
