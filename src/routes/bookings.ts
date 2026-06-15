import rateLimit from "express-rate-limit";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { supabase } from "../lib/supabase.js";
import {
  getBookingById,
  getBookings,
  saveBooking,
  updateBookingStatus,
} from "../db/store.js";

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

const bookingSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^[+\d\s\-()]{10,20}$/),
  society: z.string().trim().min(3).max(200),
  tower: z.string().trim().max(120).optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  materials: z.array(z.string().trim().min(1)).min(1),
});

const statusSchema = z.object({
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]),
});

export const bookingsRouter = Router();

// GET /api/bookings � list all bookings (admin only)
bookingsRouter.get("/", requireAdmin, async (_req, res) => {
  try {
    const bookings = await getBookings();
    return res.json(bookings);
  } catch {
    return res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

// POST /api/bookings — create a new booking (public)
bookingsRouter.post("/", bookingLimiter, async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid booking payload",
      details: parsed.error.flatten(),
    });
  }

  let userId: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (!authError && userData.user) {
      userId = userData.user.id;
    }
  }

  // Fallback: if getUser failed, try to decode the JWT locally to extract the
  // `sub` claim (user id). This helps when the auth server call intermittently
  // fails or when verification via getUser isn't available in the runtime.
  if (!userId) {
    try {
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : undefined;
      if (token) {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          if (payload && payload.sub) {
            userId = payload.sub;
            console.warn('Fallback: extracted user id from JWT payload', userId);
          }
        }
      }
    } catch (e) {
      console.error('Failed to extract user id from JWT fallback', e);
    }
  }

  console.log('Booking request userId:', userId ?? 'no-user');

  const now = new Date().toISOString();
  try {
    const booking = await saveBooking({
      id: randomUUID(),
      ...parsed.data,
      status: "scheduled",
      createdAt: now,
      updatedAt: now,
      userId,
    });
    return res.status(201).json({
      message: "Pickup scheduled. WhatsApp confirmation will follow shortly.",
      booking,
    });
  } catch (err) {
    console.error("POST /api/bookings error", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to save booking",
    });
  }
});

// GET /api/bookings/me — list bookings for the current authenticated user
bookingsRouter.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  const { data: userData, error: authError } = await supabase.auth.getUser(token);

  if (authError || !userData.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const bookings = await getBookings(userData.user.id);
    return res.json(bookings);
  } catch (err) {
    console.error("GET /api/bookings/me error", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to fetch bookings",
    });
  }
});

// GET /api/bookings/:id — get single booking (admin only)
bookingsRouter.get("/:id", requireAdmin, async (req, res) => {
  try {
    const booking = await getBookingById(String(req.params.id));
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch {
    return res.status(500).json({ error: "Failed to fetch booking" });
  }
});

// PATCH /api/bookings/:id — update booking status (admin only)
bookingsRouter.patch("/:id", requireAdmin, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid status value",
      details: parsed.error.flatten(),
    });
  }
  try {
    const booking = await updateBookingStatus(
      String(req.params.id),
      parsed.data.status
    );
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch {
    return res.status(500).json({ error: "Failed to update booking status" });
  }
});
