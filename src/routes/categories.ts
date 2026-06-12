import { Router } from "express";
import { getCategories } from "../db/store.js";

export const categoriesRouter = Router();

categoriesRouter.get("/", async (_req, res) => {
  try {
    const categories = await getCategories();
    res.json(categories);
  } catch {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});