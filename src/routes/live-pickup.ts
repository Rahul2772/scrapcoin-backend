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

livePickupRouter.get("/demo", async (_req, res) => {
  try {
    const categories = await getCategories();
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

    const pickup: LivePickup = {
      id: "demo-live-pickup",
      location: "Sample Pickup • Greater Noida West",
      status: "in_progress",
      items,
      payoutAmount: Math.round(payoutAmount * 100) / 100,
      currency: "INR",
    };

    res.json(pickup);
  } catch {
    res.status(500).json({ error: "Failed to build demo pickup" });
  }
});