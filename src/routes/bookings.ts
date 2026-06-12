import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getBookingById, getBookings, saveBooking } from "../db/store.js";

const bookingSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^[+\d\s\-()]{10,20}$/),
  society: z.string().trim().min(3).max(200),
  tower: z.string().trim().max(120).optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  materials: z.array(z.string().trim().min(1)).min(1),
});

export const bookingsRouter = Router();

bookingsRouter.get("/", async (_req, res) => {
  try {
    const bookings = await getBookings();
    return res.json(bookings);
  } catch {
    return res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

bookingsRouter.post("/", async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid booking payload",
      details: parsed.error.flatten(),
    });
  }
  const now = new Date().toISOString();
  try {
    const booking = await saveBooking({
      id: randomUUID(),
      ...parsed.data,
      status: "scheduled",
      createdAt: now,
      updatedAt: now,
    });
    return res.status(201).json({
      message: "Pickup scheduled. WhatsApp confirmation will follow shortly.",
      booking,
    });
  } catch {
    return res.status(500).json({ error: "Failed to save booking" });
  }
});

bookingsRouter.get("/:id", async (req, res) => {
  try {
    const booking = await getBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch {
    return res.status(500).json({ error: "Failed to fetch booking" });
  }
});