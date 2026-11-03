import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReports, billNumber, NOT_SET } from "./reports.js";
import { detectSociety } from "./society.js";

test("detectSociety ignores case, spaces and punctuation, longest name wins", () => {
  assert.equal(detectSociety("Flat 1204, Tower B, AJNARA HOMES-121, Sector 16B"), "Ajnara Homes");
  assert.equal(detectSociety("B-402 Ajnara Le-Garden, Noida Extension"), "Ajnara Le Garden");
  assert.equal(detectSociety("C 1101 lotus panache sector 110"), "Lotus Panache");
  assert.equal(detectSociety("House 12, Sector 62"), null);
  assert.equal(detectSociety(null), null);
  assert.equal(detectSociety("A-5 Green Valley Apts", ["Green Valley"]), "Green Valley");
});

test("billNumber groups lines of one bill", () => {
  assert.equal(billNumber("RCP-1004/2"), "RCP-1004");
  assert.equal(billNumber("TG-38/1"), "TG-38");
  assert.equal(billNumber("RCP-1005"), "RCP-1005");
});

const base = {
  materials: [
    { id: "news", name: "Newspaper", sell_price: 0 },
    { id: "iron", name: "Heavy Iron", sell_price: 30 },
    { id: "glass", name: "Glass", sell_price: 0 },
  ],
  customers: [
    { id: "c1", name: "Asha", address: "A-1 Ajnara Homes" },
    { id: "c2", name: "Ravi", society: "Galaxy Vega", lead_source: "Referral" },
  ],
  sales: [
    // Newspaper sold at 15/kg before GST in October
    { material_id: "news", weight: 100, subtotal: 1500, total_amount: 1770, created_at: "2026-10-20T06:00:00Z" },
  ],
};

test("profit uses the period's sale rate, falls back to the catalogue, groups bills", () => {
  const r = buildReports({
    ...base,
    from: "2026-10-01", to: "2026-10-31", today: "2026-11-04",
    expensesTotal: 100,
    receipts: [
      { receipt_number: "RCP-1/1", customer_id: "c1", material_id: "news", weight: 10, total_amount: 100, created_at: "2026-10-05T05:00:00Z" },
      { receipt_number: "RCP-1/2", customer_id: "c1", material_id: "iron", weight: 2, total_amount: 50, created_at: "2026-10-05T05:00:00Z" },
      { receipt_number: "RCP-2", customer_id: "c2", material_id: "news", weight: 20, total_amount: 240, created_at: "2026-10-12T05:00:00Z" },
      // Outside the period: counts for last pickup only
      { receipt_number: "RCP-0", customer_id: "c2", material_id: "news", weight: 5, total_amount: 50, created_at: "2026-09-01T05:00:00Z" },
    ],
  });

  assert.equal(r.summary.pickups, 2);
  // Bill 1: 10 kg x 15 + 2 kg x 30 (catalogue) = 210 value, paid 150
  const b1 = r.bills.find((b) => b.bill_no === "RCP-1")!;
  assert.equal(b1.lines, 2);
  assert.equal(b1.est_value, 210);
  assert.equal(b1.profit, 60);
  assert.equal(b1.society, "Ajnara Homes"); // detected from address
  // Bill 2: 20 x 15 = 300, paid 240
  assert.equal(r.bills.find((b) => b.bill_no === "RCP-2")!.profit, 60);

  assert.equal(r.summary.profit, 120);
  assert.equal(r.summary.cost_per_pickup, 50);
  assert.equal(r.summary.net_profit, 20);

  const ravi = r.customers.find((c) => c.customer_id === "c2")!;
  assert.equal(ravi.pickups, 1);
  assert.equal(ravi.net_profit, 10);
  assert.equal(ravi.lifetime_pickups, 2);
  assert.equal(ravi.first_pickup, "2026-09-01");
  assert.equal(ravi.lead_source, "Referral");
  assert.equal(r.customers.find((c) => c.customer_id === "c1")!.lead_source, NOT_SET);

  assert.deepEqual(r.societies.map((s) => s.society).sort(), ["Ajnara Homes", "Galaxy Vega"]);
  const news = r.materials.find((m) => m.material_id === "news")!;
  assert.equal(news.kg_bought, 30);
  assert.equal(news.kg_sold, 100);
  assert.equal(news.avg_sell_rate, 15);
  assert.equal(news.rate_source, "period");
  assert.equal(r.materials.find((m) => m.material_id === "iron")!.rate_source, "catalogue");
});

test("dates are read in IST and quiet customers are listed to win back", () => {
  const r = buildReports({
    ...base,
    from: "2026-10-01", to: "2026-10-31", today: "2026-11-30",
    expensesTotal: 0,
    receipts: [
      // 30 Sep 20:00 UTC is 1 Oct in IST, so it is inside October
      { receipt_number: "RCP-9", customer_id: "c1", material_id: "glass", weight: 4, total_amount: 8, created_at: "2026-09-30T20:00:00Z" },
    ],
  });
  assert.equal(r.summary.pickups, 1);
  assert.deepEqual(r.summary.unpriced_materials, ["Glass"]);
  assert.equal(r.reengage.length, 1);
  assert.equal(r.reengage[0].name, "Asha");
  assert.equal(r.reengage[0].days_since_last, 60);
});
