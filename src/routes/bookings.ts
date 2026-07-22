import rateLimit from "express-rate-limit";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAdminOrChampion } from "../middleware/requireAdminOrChampion.js";
import { supabase } from "../lib/supabase.js";
import { sendWhatsAppMessage, sendSMSMessage } from "../lib/twilio.js";
import {
  getBookingById,
  getBookings,
  saveBooking,
  updateBooking,
  deleteBooking,
} from "../db/store.js";

async function createNotification(title: string, message: string, type: string, bookingId?: string) {
  try {
    const { error } = await supabase
      .from("erp_notifications")
      .insert({
        title,
        message,
        type,
        booking_id: bookingId,
      });
    if (error && error.code !== "42P01") {
      console.error("[ERP Notifications] Error creating notification:", error);
    }
  } catch (err) {
    console.error("[ERP Notifications] Exception creating notification:", err);
  }
}

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
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).optional(),
  actualWeights: z.record(z.string(), z.number().nonnegative()).optional(),
  championId: z.string().nullable().optional(),
});

export const bookingsRouter = Router();

// GET /api/bookings — list all bookings (admin/champion)
bookingsRouter.get("/", requireAdminOrChampion, async (req, res) => {
  try {
    const isChampion = req.privilegedUser?.role === "champion";
    const bookings = await getBookings(
      undefined,
      isChampion ? req.privilegedUser?.id : undefined
    );
    return res.json(bookings);
  } catch (err) {
    console.error("GET /api/bookings error:", err);
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
    } else if (authError) {
      console.warn("Failed to verify Supabase Auth token:", authError.message);
    }
  }

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

    // In-app Notification
    createNotification(
      "New Booking Scheduled",
      `New booking created by ${parsed.data.fullName} for tower ${parsed.data.tower || "N/A"}, society ${parsed.data.society} on ${parsed.data.pickupDate}. Items: ${parsed.data.materials.join(", ")}`,
      "new_booking",
      booking.id
    );
    // Dispatch notifications asynchronously to not block the API response
    const materialsStr = parsed.data.materials.join(", ");
    const addressStr = parsed.data.tower ? `${parsed.data.tower}, ${parsed.data.society}` : parsed.data.society;
    const messageBody = `Hello ${parsed.data.fullName},\n\nThank you for choosing The Scrap Co.! Your pickup has been scheduled successfully:\n📅 Date: ${parsed.data.pickupDate}\n📍 Address: ${addressStr}\n📦 Items: ${materialsStr}\n\nOur representative will contact you on this number (${parsed.data.phone}) prior to arrival. Have a great day!`;

    sendWhatsAppMessage(parsed.data.phone, messageBody).then((waResult) => {
      console.log(`[Booking WA Notification] Dispatch: ${waResult.success ? "success" : "failed"}, ID: ${waResult.messageId || "none"}`);
    }).catch((err) => {
      console.error("[Booking WA Notification] Async Error:", err);
    });

    sendSMSMessage(parsed.data.phone, messageBody).then((smsResult) => {
      console.log(`[Booking SMS Notification] Dispatch: ${smsResult.success ? "success" : "failed"}, ID: ${smsResult.messageId || "none"}`);
    }).catch((err) => {
      console.error("[Booking SMS Notification] Async Error:", err);
    });

    const adminPhone = process.env.TWILIO_ADMIN_PHONE;
    if (adminPhone) {
      const adminMessage = `🔔 *New Pickup Scheduled!*\n\n👤 *Customer*: ${parsed.data.fullName}\n📞 *Phone*: ${parsed.data.phone}\n📅 *Date*: ${parsed.data.pickupDate}\n📍 *Address*: ${addressStr}\n📦 *Materials*: ${materialsStr}`;
      sendWhatsAppMessage(adminPhone, adminMessage).then((adminResult) => {
        console.log(`[Admin WA Notification] Dispatch: ${adminResult.success ? "success" : "failed"}, ID: ${adminResult.messageId || "none"}`);
      }).catch((err) => {
        console.error("[Admin WA Notification] Async Error:", err);
      });
    }

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

// GET /api/bookings/:id — get single booking (admin/champion)
bookingsRouter.get("/:id", requireAdminOrChampion, async (req, res) => {
  try {
    const booking = await getBookingById(String(req.params.id));
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch {
    return res.status(500).json({ error: "Failed to fetch booking" });
  }
});

// PATCH /api/bookings/:id — update booking status/assignment (admin/champion)
bookingsRouter.patch("/:id", requireAdminOrChampion, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid update payload",
      details: parsed.error.flatten(),
    });
  }

  // Champions cannot modify who is assigned to a booking
  if (req.privilegedUser?.role === "champion" && parsed.data.championId !== undefined) {
    return res.status(403).json({ error: "Champions cannot assign or modify champion assignment" });
  }

  try {
    const booking = await updateBooking(String(req.params.id), {
      status: parsed.data.status,
      actualWeights: parsed.data.actualWeights,
      championId: parsed.data.championId,
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // In-app Notification for status change
    if (parsed.data.status) {
      createNotification(
        "Booking Status Updated",
        `Booking for ${booking.fullName} has been updated to status: "${parsed.data.status.toUpperCase()}".`,
        "booking_status_change",
        booking.id
      );

      // Twilio WhatsApp/SMS Alert to Customer
      const status = parsed.data.status;
      let userMessage = "";
      if (status === "in_progress") {
        userMessage = `Hello ${booking.fullName},\n\nOur representative (champion) is on the way for your pickup.\nStatus: In Progress\n\nThank you,\nThe Scrap Co.`;
      } else if (status === "completed") {
        userMessage = `Hello ${booking.fullName},\n\nYour pickup booking has been successfully completed.\nStatus: Completed\n\nThank you for choosing The Scrap Co.!`;
      } else if (status === "cancelled") {
        userMessage = `Hello ${booking.fullName},\n\nYour pickup booking has been cancelled.\nStatus: Cancelled\n\nIf you have any questions, please contact support@scrapco.in.`;
      } else if (status === "scheduled") {
        userMessage = `Hello ${booking.fullName},\n\nYour pickup booking is scheduled.\nDate: ${booking.pickupDate}\nStatus: Scheduled`;
      }

      if (userMessage) {
        sendWhatsAppMessage(booking.phone, userMessage).then((waResult) => {
          console.log(`[Status WA Notification] Dispatch to ${booking.phone}: ${waResult.success ? "success" : "failed"}`);
        }).catch((err) => {
          console.error("[Status WA Notification] Async Error:", err);
        });

        sendSMSMessage(booking.phone, userMessage).then((smsResult) => {
          console.log(`[Status SMS Notification] Dispatch to ${booking.phone}: ${smsResult.success ? "success" : "failed"}`);
        }).catch((err) => {
          console.error("[Status SMS Notification] Async Error:", err);
        });
      }
    }

    // In-app Notification for Champion Assignment
    if (parsed.data.championId) {
      createNotification(
        "Champion Assigned",
        `Champion has been assigned to booking for ${booking.fullName}.`,
        "champion_assigned",
        booking.id
      );
    }

    return res.json(booking);
  } catch (err) {
    console.error("PATCH /api/bookings/:id error:", err);
    return res.status(500).json({ error: "Failed to update booking" });
  }
});

// DELETE /api/bookings/:id — delete a booking permanently (admin only)
bookingsRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const booking = await getBookingById(String(req.params.id));
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    await deleteBooking(String(req.params.id));
    return res.json({ success: true, message: "Booking permanently deleted" });
  } catch (err) {
    console.error("DELETE /api/bookings/:id error:", err);
    return res.status(500).json({ error: "Failed to delete booking" });
  }
});
