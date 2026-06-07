import { Router } from "express";
import { getCategories } from "../db/store.js";

export const categoriesRouter = Router();

categoriesRouter.get("/", (_req, res) => {
  res.json(getCategories());
});
