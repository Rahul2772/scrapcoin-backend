import cors from "cors";
import express from "express";
import { bookingsRouter } from "./routes/bookings.js";
import { categoriesRouter } from "./routes/categories.js";
import { livePickupRouter } from "./routes/live-pickup.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";

app.use(cors({
  origin: corsOrigin.split(",").map((o) => o.trim()),
}));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "backend_scrapco" });
});

app.use("/api/bookings", bookingsRouter);
app.use("/api/scrap-categories", categoriesRouter);
app.use("/api/live-pickup", livePickupRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`Scrap Co. API running at http://localhost:${port}`);
});