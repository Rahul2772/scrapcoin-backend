import test from "node:test";
import assert from "node:assert/strict";
import {
  getISTDateParts,
  getExpensePeriodBounds,
  calculateChangePct,
  aggregateExpenseRows,
} from "./expense-summary.js";

test("calculateChangePct calculates correct % change for current data (-93.1%)", () => {
  // This month = 599, Last month = 8699
  const change = calculateChangePct(599, 8699);
  assert.equal(change, -93.1);
});

test("calculateChangePct handles positive increase", () => {
  const change = calculateChangePct(1200, 1000);
  assert.equal(change, 20);
});

test("calculateChangePct returns null when previous period is 0", () => {
  assert.equal(calculateChangePct(500, 0), null);
  assert.equal(calculateChangePct(0, 0), null);
});

test("getISTDateParts accurately extracts year, month, day in Asia/Kolkata timezone", () => {
  // 18:30 UTC on Oct 31 is 00:00 IST on Nov 1
  const boundaryDate = new Date("2026-10-31T18:30:00.000Z");
  const parts = getISTDateParts(boundaryDate);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 1);
  assert.equal(parts.dateStr, "2026-11-01");

  // 17:30 UTC on Oct 31 is 23:00 IST on Oct 31
  const lateEveningDate = new Date("2026-10-31T17:30:00.000Z");
  const lateParts = getISTDateParts(lateEveningDate);
  assert.equal(lateParts.year, 2026);
  assert.equal(lateParts.month, 10);
  assert.equal(lateParts.day, 31);
  assert.equal(lateParts.dateStr, "2026-10-31");
});

test("getExpensePeriodBounds generates correct comparison periods for month views", () => {
  const bounds = getExpensePeriodBounds("2026-10-01", "2026-10-31");
  assert.equal(bounds.periodStart, "2026-10-01");
  assert.equal(bounds.periodEnd, "2026-10-31");
  assert.equal(bounds.prevStart, "2026-09-01");
  assert.equal(bounds.prevEnd, "2026-09-30");
  assert.equal(bounds.ytdStart, "2026-01-01");
});

test("aggregateExpenseRows: approved-only, regression math (599 vs 8699 = -93.1%), and category sorting", () => {
  const bounds = {
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    prevStart: "2026-09-01",
    prevEnd: "2026-09-30",
    ytdStart: "2026-01-01",
  };

  const sampleExpenses = [
    // October approved (400 + 199 = 599)
    {
      amount: 400,
      expense_date: "2026-10-05",
      approval_status: "approved",
      erp_expense_categories: { name: "Marketing – Offline" },
    },
    {
      amount: 199,
      expense_date: "2026-10-15",
      approval_status: "approved",
      erp_expense_categories: { name: "Internet & Telecommunication" },
    },
    // October pending & rejected (MUST be excluded)
    {
      amount: 1500,
      expense_date: "2026-10-18",
      approval_status: "pending",
      erp_expense_categories: { name: "Travel" },
    },
    {
      amount: 2500,
      expense_date: "2026-10-20",
      approval_status: "rejected",
      erp_expense_categories: { name: "Transport" },
    },
    // October voided (MUST be excluded)
    {
      amount: 999,
      expense_date: "2026-10-22",
      approval_status: "approved",
      is_void: true,
      erp_expense_categories: { name: "Print" },
    },
    // September approved (500 + 8000 + 199 = 8699)
    {
      amount: 500,
      expense_date: "2026-09-02",
      approval_status: "approved",
      erp_expense_categories: { name: "Marketing – Offline" },
    },
    {
      amount: 8000,
      expense_date: "2026-09-10",
      approval_status: "approved",
      erp_expense_categories: { name: "Marketing – Offline" },
    },
    {
      amount: 199,
      expense_date: "2026-09-20",
      approval_status: "approved",
      erp_expense_categories: { name: "Internet & Telecommunication" },
    },
    // September rejected (MUST be excluded)
    {
      amount: 12000,
      expense_date: "2026-09-25",
      approval_status: "rejected",
      erp_expense_categories: { name: "Rent" },
    },
  ];

  const result = aggregateExpenseRows(sampleExpenses, bounds);

  // Exact math from guide:
  // This month = 599
  assert.equal(result.total_approved, 599);
  // Last month = 8699
  assert.equal(result.previous_period_total, 8699);
  // Change = -93.1%
  assert.equal(result.change_pct, -93.1);
  // YTD = 599 + 8699 = 9298
  assert.equal(result.year_to_date, 9298);

  // Top category is Marketing – Offline (400)
  assert.equal(result.top_category, "Marketing – Offline");
  assert.equal(result.by_category.length, 2);
  assert.equal(result.by_category[0].name, "Marketing – Offline");
  assert.equal(result.by_category[0].total, 400);
  assert.equal(result.by_category[1].name, "Internet & Telecommunication");
  assert.equal(result.by_category[1].total, 199);
});
