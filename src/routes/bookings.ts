import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getBookingById, saveBooking } from "../db/store.js";

const bookingSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(10).max(20),
  society: z.string().trim().min(3).max(200),
  tower: z.string().trim().max(120).optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  materials: z.array(z.string().trim().min(1)).min(1),
});

export const bookingsRouter = Router();

bookingsRouter.post("/", (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid booking payload",
      details: parsed.error.flatten(),
    });
  }

  const now = new Date().toISOString();
  const booking = saveBooking({
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
});

bookingsRouter.get("/:id", (req, res) => {
  const booking = getBookingById(req.params.id);
  if (!booking) {
    return res.status(404).json({ error: "Booking not found" });
  }
  return res.json(booking);
});
