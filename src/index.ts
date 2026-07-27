import cors from "cors";
import express from "express";
import { adminRouter } from "./routes/admin.js";
import { bookingsRouter } from "./routes/bookings.js";
import { categoriesRouter } from "./routes/categories.js";
import { livePickupRouter } from "./routes/live-pickup.js";
import { erpRouter } from "./routes/erp.js";
import { notificationsRouter } from "./routes/notifications.js";

const app = express();
// Behind proxies (e.g. Railway, Vercel), enable trust proxy so
// express-rate-limit can correctly identify client IPs from
// the X-Forwarded-For header.
app.set("trust proxy", true);
const port = Number(process.env.PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";

// Always include production domains so the live site can talk to this backend
const ALWAYS_ALLOWED_ORIGINS = [
  "https://scrapco.in",
  "https://www.scrapco.in",
  "http://localhost:5173",
  "http://localhost:4000",
];
const allowedOrigins = Array.from(
  new Set([
    ...corsOrigin.split(",").map((o) => o.trim()),
    ...ALWAYS_ALLOWED_ORIGINS,
  ])
);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "Welcome to The Scrap Co. API backend", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "backend_scrapco" });
});

app.use("/api/bookings", bookingsRouter);
app.use("/api/scrap-categories", categoriesRouter);
app.use("/api/live-pickup", livePickupRouter);
app.use("/api/admin", adminRouter);
app.use("/api/erp", erpRouter);
app.use("/api/notifications", notificationsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`Scrap Co. API running at http://localhost:${port}`);
});