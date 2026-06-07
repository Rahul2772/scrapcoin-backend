import { Router } from "express";
import { getCategories } from "../db/store.js";
import type { LivePickup } from "../types.js";

export const livePickupRouter = Router();

const DEMO_WEIGHTS: Record<string, number> = {
  cardboard: 4.2,
  plastics: 1.8,
  metals: 2.6,
  "e-waste": 0.5,
};

function buildDemoPickup(): LivePickup {
  const categories = getCategories();
  const items = categories
    .filter((c) => DEMO_WEIGHTS[c.id] !== undefined)
    .map((c) => ({
      label: c.name.split(" / ")[0] ?? c.name,
      weightKg: DEMO_WEIGHTS[c.id],
      categoryId: c.id,
    }));

  const payoutAmount = items.reduce((sum, item) => {
    const category = categories.find((c) => c.id === item.categoryId);
    return sum + item.weightKg * (category?.pricePerUnit ?? 0);
  }, 0);

  return {
    id: "demo-live-pickup",
    location: "Tower B-204 • Sector 16C",
    status: "in_progress",
    items,
    payoutAmount: Math.round(payoutAmount * 100) / 100,
    currency: "INR",
  };
}

livePickupRouter.get("/demo", (_req, res) => {
  res.json(buildDemoPickup());
});
