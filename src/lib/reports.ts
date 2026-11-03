import { getISTDateParts } from "./expense-summary.js";
import { detectSociety } from "./society.js";

// ── Inputs (rows as read from Supabase) ──────────────────────────────────────
export interface ReportReceiptLine {
  receipt_number: string;
  customer_id: string | null;
  material_id: string | null;
  weight: number | string;
  total_amount: number | string;
  created_at: string;
}
export interface ReportSaleLine {
  material_id: string | null;
  weight: number | string;
  subtotal?: number | string | null;
  total_amount?: number | string | null;
  created_at: string;
}
export interface ReportCustomer {
  id: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  society?: string | null;
  lead_source?: string | null;
}
export interface ReportMaterial {
  id: string;
  name: string;
  color_hex?: string | null;
  sell_price?: number | string | null;
}

export interface ReportInput {
  from?: string; // YYYY-MM-DD (IST), inclusive
  to?: string;
  receipts: ReportReceiptLine[]; // all time: needed for last pickup and lifetime figures
  sales: ReportSaleLine[];       // all time
  customers: ReportCustomer[];
  materials: ReportMaterial[];
  expensesTotal: number;          // approved expenses inside the period
  reengageAfterDays?: number;
  today?: string;                 // YYYY-MM-DD, for tests
}

export const NOT_SET = "Not set";
const WALK_IN = "Walk-in / no customer";

const n = (v: unknown) => Number(v) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const istDate = (iso: string) => getISTDateParts(new Date(iso)).dateStr;
// "RCP-1004/2" and "TG-38/1" belong to bills "RCP-1004" and "TG-38"
export const billNumber = (receiptNumber: string) => String(receiptNumber || "").split("/")[0];

type RateSource = "period" | "all_time" | "catalogue" | "none";
interface Rate { rate: number; source: RateSource }

// Average price recyclers paid us per kg (before GST): the period's sales,
// else all sales, else the catalogue sell price.
function sellRates(input: ReportInput, inPeriod: (d: string) => boolean): Record<string, Rate> {
  const sum = (lines: ReportSaleLine[]) => {
    const m: Record<string, { kg: number; amt: number }> = {};
    for (const s of lines) {
      if (!s.material_id) continue;
      const amt = s.subtotal != null ? n(s.subtotal) : n(s.total_amount);
      (m[s.material_id] ??= { kg: 0, amt: 0 });
      m[s.material_id].kg += n(s.weight);
      m[s.material_id].amt += amt;
    }
    return m;
  };
  const period = sum(input.sales.filter((s) => inPeriod(istDate(s.created_at))));
  const all = sum(input.sales);
  const rates: Record<string, Rate> = {};
  for (const mat of input.materials) {
    const p = period[mat.id], a = all[mat.id];
    if (p && p.kg > 0) rates[mat.id] = { rate: p.amt / p.kg, source: "period" };
    else if (a && a.kg > 0) rates[mat.id] = { rate: a.amt / a.kg, source: "all_time" };
    else if (n(mat.sell_price) > 0) rates[mat.id] = { rate: n(mat.sell_price), source: "catalogue" };
    else rates[mat.id] = { rate: 0, source: "none" };
  }
  return rates;
}

interface Totals { kg: number; paid: number; value: number }
const addTo = (t: Totals, kg: number, paid: number, value: number) => {
  t.kg += kg; t.paid += paid; t.value += value;
};
const money = (t: Totals) => ({
  kg: r2(t.kg),
  paid: r2(t.paid),
  est_value: r2(t.value),
  profit: r2(t.value - t.paid),
  margin_pct: pct(t.value - t.paid, t.value),
});

export function buildReports(input: ReportInput) {
  const from = input.from || "0000-01-01";
  const to = input.to || "9999-12-31";
  const inPeriod = (d: string) => d >= from && d <= to;
  const today = input.today || getISTDateParts().dateStr;
  const reengageAfter = input.reengageAfterDays ?? 45;

  const rates = sellRates(input, inPeriod);
  const allRates = sellRates({ ...input }, () => true);
  const mats = new Map(input.materials.map((m) => [m.id, m]));
  const custs = new Map(input.customers.map((c) => [c.id, c]));
  const savedSocieties = input.customers.map((c) => c.society || "").filter(Boolean);

  const societyOf = (c?: ReportCustomer) =>
    (c?.society && c.society.trim()) || detectSociety(c?.address, savedSocieties) || NOT_SET;
  const sourceOf = (c?: ReportCustomer) => (c?.lead_source && c.lead_source.trim()) || NOT_SET;
  const valueOf = (line: ReportReceiptLine, rs: Record<string, Rate>) =>
    n(line.weight) * (line.material_id && rs[line.material_id] ? rs[line.material_id].rate : 0);
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

  const lines = input.receipts.map((l) => ({ ...l, date: istDate(l.created_at), bill: billNumber(l.receipt_number) }));
  const periodLines = lines.filter((l) => inPeriod(l.date));

  // ── Bills ──
  const billMap = new Map<string, { bill_no: string; date: string; customer_id: string | null; lines: number; t: Totals; materials: Set<string> }>();
  for (const l of periodLines) {
    const b = billMap.get(l.bill) ?? { bill_no: l.bill, date: l.date, customer_id: l.customer_id, lines: 0, t: { kg: 0, paid: 0, value: 0 }, materials: new Set<string>() };
    b.lines++;
    if (l.date < b.date) b.date = l.date;
    b.customer_id ??= l.customer_id;
    addTo(b.t, n(l.weight), n(l.total_amount), valueOf(l, rates));
    b.materials.add(mats.get(l.material_id || "")?.name || "Unknown");
    billMap.set(l.bill, b);
  }
  const pickups = billMap.size;
  const totals: Totals = { kg: 0, paid: 0, value: 0 };
  for (const b of billMap.values()) addTo(totals, b.t.kg, b.t.paid, b.t.value);
  const costPerPickup = pickups > 0 ? input.expensesTotal / pickups : 0;

  const bills = [...billMap.values()]
    .map((b) => {
      const c = b.customer_id ? custs.get(b.customer_id) : undefined;
      return {
        bill_no: b.bill_no,
        date: b.date,
        customer_id: b.customer_id,
        customer_name: c?.name || WALK_IN,
        society: societyOf(c),
        lines: b.lines,
        materials: [...b.materials],
        ...money(b.t),
      };
    })
    .sort((a, b) => (a.date === b.date ? b.bill_no.localeCompare(a.bill_no) : b.date.localeCompare(a.date)));

  // ── Customers (period figures + lifetime pickup dates) ──
  const lifetime = new Map<string, { first: string; last: string; bills: Set<string>; profit: number }>();
  for (const l of lines) {
    const key = l.customer_id || "";
    const lt = lifetime.get(key) ?? { first: l.date, last: l.date, bills: new Set<string>(), profit: 0 };
    if (l.date < lt.first) lt.first = l.date;
    if (l.date > lt.last) lt.last = l.date;
    lt.bills.add(l.bill);
    lt.profit += valueOf(l, allRates) - n(l.total_amount);
    lifetime.set(key, lt);
  }

  const group = <K extends string>(keyOf: (b: (typeof bills)[number]) => K) => {
    const m = new Map<K, { pickups: number; customers: Set<string>; t: Totals }>();
    for (const b of bills) {
      const k = keyOf(b);
      const g = m.get(k) ?? { pickups: 0, customers: new Set<string>(), t: { kg: 0, paid: 0, value: 0 } };
      g.pickups++;
      g.customers.add(b.customer_id || "");
      addTo(g.t, b.kg, b.paid, b.est_value);
      m.set(k, g);
    }
    return m;
  };
  const withNet = (g: { pickups: number; t: Totals }) => {
    const base = money(g.t);
    const net = base.profit - g.pickups * costPerPickup;
    return {
      pickups: g.pickups,
      ...base,
      net_profit: r2(net),
      profit_per_pickup: g.pickups ? r2(base.profit / g.pickups) : 0,
      kg_per_pickup: g.pickups ? r2(g.t.kg / g.pickups) : 0,
    };
  };

  const customers = [...group((b) => b.customer_id || "")].map(([id, g]) => {
    const c = custs.get(id);
    const lt = lifetime.get(id);
    return {
      customer_id: id || null,
      name: c?.name || WALK_IN,
      phone: c?.phone || null,
      society: societyOf(c),
      lead_source: sourceOf(c),
      ...withNet(g),
      first_pickup: lt?.first || null,
      last_pickup: lt?.last || null,
      days_since_last: lt ? daysBetween(lt.last, today) : null,
      lifetime_pickups: lt?.bills.size || 0,
    };
  }).sort((a, b) => b.profit - a.profit);

  // Material mix per society (kg by material)
  const mixBySociety = new Map<string, Map<string, number>>();
  for (const l of periodLines) {
    const soc = societyOf(l.customer_id ? custs.get(l.customer_id) : undefined);
    const mix = mixBySociety.get(soc) ?? new Map<string, number>();
    const name = mats.get(l.material_id || "")?.name || "Unknown";
    mix.set(name, (mix.get(name) || 0) + n(l.weight));
    mixBySociety.set(soc, mix);
  }

  const societies = [...group((b) => b.society)].map(([society, g]) => ({
    society,
    customers: [...g.customers].filter(Boolean).length,
    ...withNet(g),
    top_materials: [...(mixBySociety.get(society) || new Map())]
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, kg]) => ({ name, kg: r2(kg) })),
  })).sort((a, b) => b.profit - a.profit);

  const sources = [...group((b) => sourceOf(b.customer_id ? custs.get(b.customer_id) : undefined))]
    .map(([lead_source, g]) => ({
      lead_source,
      customers: [...g.customers].filter(Boolean).length,
      ...withNet(g),
    })).sort((a, b) => b.profit - a.profit);

  // ── Materials ──
  const matMap = new Map<string, { bought: Totals; soldKg: number; soldAmt: number }>();
  for (const l of periodLines) {
    const id = l.material_id || "";
    const m = matMap.get(id) ?? { bought: { kg: 0, paid: 0, value: 0 }, soldKg: 0, soldAmt: 0 };
    addTo(m.bought, n(l.weight), n(l.total_amount), valueOf(l, rates));
    matMap.set(id, m);
  }
  for (const s of input.sales) {
    if (!inPeriod(istDate(s.created_at))) continue;
    const id = s.material_id || "";
    const m = matMap.get(id) ?? { bought: { kg: 0, paid: 0, value: 0 }, soldKg: 0, soldAmt: 0 };
    m.soldKg += n(s.weight);
    m.soldAmt += s.subtotal != null ? n(s.subtotal) : n(s.total_amount);
    matMap.set(id, m);
  }
  const materials = [...matMap].map(([id, m]) => {
    const mat = mats.get(id);
    const buyRate = m.bought.kg > 0 ? m.bought.paid / m.bought.kg : null;
    const rate = rates[id];
    return {
      material_id: id || null,
      name: mat?.name || "Unknown",
      color_hex: mat?.color_hex || "#f5a623",
      kg_bought: r2(m.bought.kg),
      paid: r2(m.bought.paid),
      avg_buy_rate: buyRate == null ? null : r2(buyRate),
      kg_sold: r2(m.soldKg),
      sale_revenue: r2(m.soldAmt),
      avg_sell_rate: rate && rate.source !== "none" ? r2(rate.rate) : null,
      rate_source: rate?.source || "none",
      margin_per_kg: buyRate != null && rate && rate.source !== "none" ? r2(rate.rate - buyRate) : null,
      est_profit: r2(m.bought.value - m.bought.paid),
      share_kg_pct: pct(m.bought.kg, totals.kg),
    };
  }).sort((a, b) => b.est_profit - a.est_profit);

  // ── Customers to win back: no pickup for a while, most profitable first ──
  const reengage = [...lifetime]
    .filter(([id]) => id && custs.has(id))
    .map(([id, lt]) => {
      const c = custs.get(id)!;
      return {
        customer_id: id,
        name: c.name,
        phone: c.phone || null,
        society: societyOf(c),
        last_pickup: lt.last,
        days_since_last: daysBetween(lt.last, today),
        lifetime_pickups: lt.bills.size,
        lifetime_profit: r2(lt.profit),
      };
    })
    .filter((c) => c.days_since_last >= reengageAfter)
    .sort((a, b) => b.lifetime_profit - a.lifetime_profit);

  const base = money(totals);
  return {
    period: { from: input.from || null, to: input.to || null },
    summary: {
      pickups,
      customers: new Set(bills.map((b) => b.customer_id).filter(Boolean)).size,
      ...base,
      expenses: r2(input.expensesTotal),
      net_profit: r2(base.profit - input.expensesTotal),
      cost_per_pickup: r2(costPerPickup),
      profit_per_pickup: pickups ? r2(base.profit / pickups) : 0,
      kg_per_pickup: pickups ? r2(totals.kg / pickups) : 0,
      unpriced_materials: materials.filter((m) => m.rate_source === "none" && m.kg_bought > 0).map((m) => m.name),
    },
    bills,
    customers,
    societies,
    sources,
    materials,
    reengage,
    reengage_after_days: reengageAfter,
  };
}

export type ReportsResult = ReturnType<typeof buildReports>;
