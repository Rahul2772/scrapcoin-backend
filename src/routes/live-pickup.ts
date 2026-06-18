import { Router } from "express";
import { getCategories, getBookings } from "../db/store.js";
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

// GET /api/live-pickup/impact — dynamic landfill diversion totals
livePickupRouter.get("/impact", async (_req, res) => {
  try {
    const bookings = await getBookings();
    
    const completedBookings = bookings.filter((b) => b.status === "completed");

    // Conservative industry averages per completed booking slot
    // Matches the materials names listed in the frontend:
    // "Paper / Cardboard", "Plastics", "Metals", "E-Waste", "Others"
    const MULTIPLIERS: Record<string, number> = {
      "Paper / Cardboard": 12.5,
      "Plastics": 3.8,
      "Metals": 5.4,
      "E-Waste": 2.1,
      "Others": 1.5,
    };

    // Historical seeded totals so the site starts with traction from past pickups
    const SEED_WEIGHTS: Record<string, number> = {
      "Paper / Cardboard": 1140.0,
      "Plastics": 380.0,
      "Metals": 486.0,
      "E-Waste": 92.0,
      "Others": 45.0,
    };

    const weights: Record<string, number> = {
      "Paper / Cardboard": SEED_WEIGHTS["Paper / Cardboard"],
      "Plastics": SEED_WEIGHTS["Plastics"],
      "Metals": SEED_WEIGHTS["Metals"],
      "E-Waste": SEED_WEIGHTS["E-Waste"],
      "Others": SEED_WEIGHTS["Others"],
    };

    // Aggregate weights from completed bookings
    for (const booking of completedBookings) {
      if (booking.actualWeights && Object.keys(booking.actualWeights).length > 0) {
        // Use recorded actual weights entered by champions/admins
        for (const [mat, weight] of Object.entries(booking.actualWeights)) {
          if (weights[mat] !== undefined) {
            weights[mat] += Number(weight);
          }
        }
      } else if (booking.materials && Array.isArray(booking.materials)) {
        // Fallback to estimated averages if actual weights were not recorded
        for (const mat of booking.materials) {
          if (weights[mat] !== undefined) {
            weights[mat] += MULTIPLIERS[mat] ?? 0;
          }
        }
      }
    }

    const breakdown = [
      { categoryId: "paper", label: "Paper & Cardboard", weightKg: Math.round(weights["Paper / Cardboard"] * 10) / 10 },
      { categoryId: "plastics", label: "Plastics", weightKg: Math.round(weights["Plastics"] * 10) / 10 },
      { categoryId: "metals", label: "Metals", weightKg: Math.round(weights["Metals"] * 10) / 10 },
      { categoryId: "e-waste", label: "E-Waste", weightKg: Math.round(weights["E-Waste"] * 10) / 10 },
      { categoryId: "others", label: "Others", weightKg: Math.round(weights["Others"] * 10) / 10 },
    ];

    const grandTotalKg = breakdown.reduce((sum, item) => sum + item.weightKg, 0);

    res.json({
      grandTotalKg: Math.round(grandTotalKg * 10) / 10,
      breakdown,
    });
  } catch (err) {
    console.error("GET /api/live-pickup/impact error", err);
    res.status(500).json({ error: "Failed to calculate dynamic impact stats" });
  }
});