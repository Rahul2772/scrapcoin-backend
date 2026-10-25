import { supabase } from "./supabase.js";

/**
 * Returns date parts strictly formatted in Asia/Kolkata (IST).
 */
export function getISTDateParts(d: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateStr = formatter.format(d);
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day, dateStr };
}

/**
 * Determines exact period and comparison period dates in Asia/Kolkata (IST).
 */
export function getExpensePeriodBounds(from?: string, to?: string) {
  const { year, month, dateStr } = getISTDateParts();

  if (from && to) {
    const periodStart = from;
    const periodEnd = to;

    // Check if it's a full calendar month (e.g. YYYY-MM-01 to YYYY-MM-lastDay)
    const [fromY, fromM, fromD] = from.split("-").map(Number);
    const [toY, toM, toD] = to.split("-").map(Number);
    const lastDayFromMonth = new Date(Date.UTC(fromY, fromM, 0)).getUTCDate();

    let prevStart: string;
    let prevEnd: string;

    if (fromD === 1 && fromY === toY && fromM === toM && toD === lastDayFromMonth) {
      // Exactly one calendar month -> compare to previous calendar month
      const prevMonthYear = fromM === 1 ? fromY - 1 : fromY;
      const prevMonth = fromM === 1 ? 12 : fromM - 1;
      const prevLastDay = new Date(Date.UTC(prevMonthYear, prevMonth, 0)).getUTCDate();
      prevStart = `${prevMonthYear}-${String(prevMonth).padStart(2, "0")}-01`;
      prevEnd = `${prevMonthYear}-${String(prevMonth).padStart(2, "0")}-${String(prevLastDay).padStart(2, "0")}`;
    } else {
      // Arbitrary date range: shift back by same duration in days
      const startMs = new Date(from).getTime();
      const endMs = new Date(to).getTime();
      const durationMs = Math.max(86400000, endMs - startMs + 86400000);
      const prevEndMs = startMs - 86400000;
      const prevStartMs = prevEndMs - durationMs + 86400000;
      prevStart = new Date(prevStartMs).toISOString().split("T")[0];
      prevEnd = new Date(prevEndMs).toISOString().split("T")[0];
    }

    const ytdStart = `${fromY}-01-01`;
    return { periodStart, periodEnd, prevStart, prevEnd, ytdStart };
  }

  // Default: Current calendar month in Asia/Kolkata (IST)
  const lastDayThisMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const periodStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const periodEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDayThisMonth).padStart(2, "0")}`;

  const prevMonthYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevLastDay = new Date(Date.UTC(prevMonthYear, prevMonth, 0)).getUTCDate();
  const prevStart = `${prevMonthYear}-${String(prevMonth).padStart(2, "0")}-01`;
  const prevEnd = `${prevMonthYear}-${String(prevMonth).padStart(2, "0")}-${String(prevLastDay).padStart(2, "0")}`;

  const ytdStart = `${year}-01-01`;
  return { periodStart, periodEnd, prevStart, prevEnd, ytdStart };
}

/**
 * Computes percentage change. If previous total is zero, returns null.
 */
export function calculateChangePct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

export interface ExpenseSummaryResult {
  period: { from: string; to: string };
  total_approved: number;
  this_month_total: number;
  previous_period_total: number;
  last_month_total: number;
  change_pct: number | null;
  pct_change: number | null;
  year_to_date: number;
  pending_count: number;
  top_category: string | null;
  by_category: { category: string; name: string; total: number; count: number }[];
  monthly_trend: { month: string; total: number }[];
}

/**
 * Pure aggregation function for expense records.
 * Enforces:
 * - ONLY approved expenses count in totals (pending and rejected are excluded)
 * - Voided expenses (is_void = true) are excluded
 */
export function aggregateExpenseRows(
  allExpenses: Array<{
    amount: number | string;
    expense_date: string;
    approval_status: string;
    is_void?: boolean;
    erp_expense_categories?:
      | { id?: string; name?: string }
      | Array<{ id?: string; name?: string }>
      | null;
  }>,
  bounds: {
    periodStart: string;
    periodEnd: string;
    prevStart: string;
    prevEnd: string;
    ytdStart: string;
  }
) {
  const { periodStart, periodEnd, prevStart, prevEnd, ytdStart } = bounds;

  let totalApproved = 0;
  let prevTotal = 0;
  let ytdTotal = 0;
  const categoryMap: Record<string, { total: number; count: number; name: string }> = {};

  for (const e of allExpenses || []) {
    // Strict rule: approved only, non-voided only
    if (e.approval_status !== "approved" || e.is_void) {
      continue;
    }

    const amt = Number(e.amount) || 0;
    const date = e.expense_date;

    // Current period
    if (date >= periodStart && date <= periodEnd) {
      totalApproved += amt;
      const catObj = Array.isArray(e.erp_expense_categories)
        ? e.erp_expense_categories[0]
        : e.erp_expense_categories;
      const catName = catObj?.name || "Uncategorised";
      if (!categoryMap[catName]) {
        categoryMap[catName] = { total: 0, count: 0, name: catName };
      }
      categoryMap[catName].total += amt;
      categoryMap[catName].count += 1;
    }

    // Previous period
    if (date >= prevStart && date <= prevEnd) {
      prevTotal += amt;
    }

    // Year to date
    if (date >= ytdStart && date <= periodEnd) {
      ytdTotal += amt;
    }
  }

  const byCategory = Object.values(categoryMap)
    .map((v) => ({
      category: v.name,
      name: v.name,
      total: Number(v.total.toFixed(2)),
      count: v.count,
    }))
    .sort((a, b) => b.total - a.total);

  const topCategory = byCategory[0]?.name || null;
  const changePct = calculateChangePct(totalApproved, prevTotal);

  return {
    total_approved: Number(totalApproved.toFixed(2)),
    previous_period_total: Number(prevTotal.toFixed(2)),
    change_pct: changePct,
    year_to_date: Number(ytdTotal.toFixed(2)),
    by_category: byCategory,
    top_category: topCategory,
  };
}

/**
 * Single source of truth for expense calculations across Dashboard and ERP Expenses tab.
 * Enforces:
 * - ONLY approved expenses count in totals
 * - is_void = false
 * - Asia/Kolkata (IST) month boundaries
 */
export async function getExpenseSummaryData(
  query: { from?: string; to?: string } = {}
): Promise<ExpenseSummaryResult> {
  const bounds = getExpensePeriodBounds(query.from, query.to);
  const { periodStart, periodEnd, prevStart, ytdStart } = bounds;

  // Query Supabase for all expenses that could fall within the comparison window or YTD
  const earliestDate = [prevStart, ytdStart, periodStart].sort()[0];

  const { data: rawExpenses, error: expensesErr } = await supabase
    .from("erp_expenses")
    .select("amount, expense_date, approval_status, is_void, erp_expense_categories(id, name)")
    .eq("approval_status", "approved")
    .eq("is_void", false)
    .gte("expense_date", earliestDate)
    .lte("expense_date", periodEnd);

  if (expensesErr) throw expensesErr;

  const aggregated = aggregateExpenseRows(rawExpenses || [], bounds);

  // Pending approval count
  const { count: pendingCount, error: pendingErr } = await supabase
    .from("erp_expenses")
    .select("id", { count: "exact", head: true })
    .eq("approval_status", "pending")
    .eq("is_void", false);

  if (pendingErr) throw pendingErr;

  // Monthly trend (last 12 calendar months)
  const [startY, startM] = periodStart.split("-").map(Number);
  const trendStartDate = new Date(startY, startM - 12, 1);
  const trendStartStr = `${trendStartDate.getFullYear()}-${String(trendStartDate.getMonth() + 1).padStart(2, "0")}-01`;

  const { data: trendData, error: trendErr } = await supabase
    .from("erp_expenses")
    .select("amount, expense_date")
    .eq("approval_status", "approved")
    .eq("is_void", false)
    .gte("expense_date", trendStartStr);

  if (trendErr) throw trendErr;

  const monthMap: Record<string, number> = {};
  for (const e of trendData || []) {
    const m = e.expense_date.substring(0, 7);
    monthMap[m] = (monthMap[m] || 0) + Number(e.amount);
  }
  const monthlyTrend = Object.entries(monthMap)
    .map(([month, tot]) => ({ month, total: Number(tot.toFixed(2)) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    period: { from: periodStart, to: periodEnd },
    total_approved: aggregated.total_approved,
    this_month_total: aggregated.total_approved,
    previous_period_total: aggregated.previous_period_total,
    last_month_total: aggregated.previous_period_total,
    change_pct: aggregated.change_pct,
    pct_change: aggregated.change_pct,
    year_to_date: aggregated.year_to_date,
    pending_count: pendingCount ?? 0,
    top_category: aggregated.top_category,
    by_category: aggregated.by_category,
    monthly_trend: monthlyTrend,
  };
}
