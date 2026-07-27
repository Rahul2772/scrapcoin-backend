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
  updateBookingCRM,
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

import { isPincodeSupported } from "../lib/pincodes.js";

const bookingSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^[+\d\s\-()]{10,20}$/),
  society: z.string().trim().min(3).max(200),
  tower: z.string().trim().max(120).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/, "Pincode must be 6 digits").optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  materials: z.array(z.string().trim().min(1)).min(1),
});

const statusSchema = z.object({
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).optional(),
  actualWeights: z.record(z.string(), z.number().nonnegative()).optional(),
  championId: z.string().nullable().optional(),
  statusComments: z.string().nullable().optional(),
});

// Schema for admin-created bookings (WhatsApp/manual entry) — no rate limit
const adminBookingSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^[+\d\s\-()]{10,20}$/),
  society: z.string().trim().min(1).max(200),
  tower: z.string().trim().max(120).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/, "Pincode must be 6 digits").optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  materials: z.array(z.string().trim().min(1)).min(1),
  source: z.enum(["website", "whatsapp", "admin"]).default("admin"),
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).default("scheduled"),
  inquiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  lastCommunicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  statusComments: z.string().trim().max(2000).optional().nullable(),
});

const crmUpdateSchema = z.object({
  inquiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  lastCommunicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  statusComments: z.string().trim().max(2000).optional().nullable(),
});

// Helper: upsert ERP customer when booking is confirmed (scheduled/completed)
async function upsertERPCustomerFromBooking(booking: {
  fullName: string;
  phone: string;
  society: string;
  tower?: string;
}) {
  try {
    const address = booking.tower
      ? `${booking.tower}, ${booking.society}`
      : booking.society;

    // Check if customer with same phone already exists
    const { data: existing } = await supabase
      .from("erp_customers")
      .select("id")
      .eq("phone", booking.phone)
      .maybeSingle();

    if (existing) {
      // Already in ERP — just update address/name in case they changed
      await supabase
        .from("erp_customers")
        .update({ name: booking.fullName, address, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      console.log(`[ERP] Updated existing customer phone=${booking.phone}`);
    } else {
      // Insert new ERP customer
      const { randomUUID } = await import("node:crypto");
      await supabase.from("erp_customers").insert({
        id: randomUUID(),
        name: booking.fullName,
        phone: booking.phone,
        whatsapp: booking.phone,
        address,
        notes: "Auto-created from booking confirmation",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      console.log(`[ERP] Created new customer from booking: ${booking.fullName}`);
    }
  } catch (err) {
    console.error("[ERP] upsertERPCustomerFromBooking error:", err);
  }
}

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

  if (parsed.data.pincode && !isPincodeSupported(parsed.data.pincode)) {
    return res.status(400).json({
      error: `Pickup is currently not available for pincode ${parsed.data.pincode}. Supported areas: Noida, Greater Noida, Noida Extension & Indirapuram.`,
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

// POST /api/bookings/admin — create a manual booking (admin/champion, no rate limit, for WhatsApp inquiries)
bookingsRouter.post("/admin", requireAdminOrChampion, async (req, res) => {
  const parsed = adminBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid booking payload",
      details: parsed.error.flatten(),
    });
  }

  if (parsed.data.pincode && !isPincodeSupported(parsed.data.pincode)) {
    return res.status(400).json({
      error: `Pickup is currently not available for pincode ${parsed.data.pincode}. Supported areas: Noida, Greater Noida, Noida Extension & Indirapuram.`,
    });
  }

  const now = new Date().toISOString();
  const { randomUUID } = await import("node:crypto");
  try {
    const booking = await saveBooking({
      id: randomUUID(),
      fullName: parsed.data.fullName,
      phone: parsed.data.phone,
      society: parsed.data.society,
      tower: parsed.data.tower,
      pickupDate: parsed.data.pickupDate,
      materials: parsed.data.materials,
      status: parsed.data.status,
      createdAt: now,
      updatedAt: now,
      source: parsed.data.source,
      inquiryDate: parsed.data.inquiryDate ?? null,
      lastCommunicationDate: parsed.data.lastCommunicationDate ?? null,
      statusComments: parsed.data.statusComments ?? null,
      userId: req.privilegedUser?.id,
    });

    createNotification(
      "New Admin Booking Created",
      `Admin created a manual booking for ${parsed.data.fullName} (${parsed.data.source}) — Pickup: ${parsed.data.pickupDate}.`,
      "new_booking",
      booking.id
    );

    // Auto-upsert ERP customer if status is scheduled/completed
    if (parsed.data.status === "scheduled" || parsed.data.status === "completed") {
      upsertERPCustomerFromBooking({
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        society: parsed.data.society,
        tower: parsed.data.tower,
      });
    }

    return res.status(201).json({ message: "Booking created.", booking });
  } catch (err) {
    console.error("POST /api/bookings/admin error", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to save booking",
    });
  }
});

// PATCH /api/bookings/:id/crm — update CRM tracking fields only (admin/champion)
bookingsRouter.patch("/:id/crm", requireAdminOrChampion, async (req, res) => {
  const parsed = crmUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid CRM update payload",
      details: parsed.error.flatten(),
    });
  }
  try {
    const booking = await updateBookingCRM(String(req.params.id), {
      inquiryDate: parsed.data.inquiryDate,
      lastCommunicationDate: parsed.data.lastCommunicationDate,
      statusComments: parsed.data.statusComments,
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    return res.json(booking);
  } catch (err) {
    console.error("PATCH /api/bookings/:id/crm error:", err);
    return res.status(500).json({ error: "Failed to update CRM fields" });
  }
});

// PUT /api/bookings/:id — edit core booking fields (admin only)
bookingsRouter.put("/:id", requireAdmin, async (req, res) => {
  const editSchema = z.object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().min(6).max(20).optional(),
    society: z.string().trim().min(2).max(200).optional(),
    tower: z.string().trim().max(120).optional().nullable(),
    pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    materials: z.array(z.string().trim().min(1)).min(1).optional(),
    source: z.enum(["website", "whatsapp", "admin"]).optional(),
  });

  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid edit payload", details: parsed.error.flatten() });
  }

  try {
    const booking = await getBookingById(String(req.params.id));
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.fullName  !== undefined) updatePayload.full_name  = parsed.data.fullName;
    if (parsed.data.phone     !== undefined) updatePayload.phone      = parsed.data.phone;
    if (parsed.data.society   !== undefined) updatePayload.society    = parsed.data.society;
    if (parsed.data.tower     !== undefined) updatePayload.tower      = parsed.data.tower ?? null;
    if (parsed.data.pickupDate!== undefined) updatePayload.pickup_date= parsed.data.pickupDate;
    if (parsed.data.materials !== undefined) updatePayload.materials  = parsed.data.materials;
    if (parsed.data.source    !== undefined) updatePayload.source     = parsed.data.source;

    const { data, error } = await supabase
      .from("bookings")
      .update(updatePayload)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Booking not found after update" });

    // Map snake_case DB row → camelCase Booking shape expected by frontend
    const updated = {
      id: data.id,
      fullName: data.full_name,
      phone: data.phone,
      society: data.society,
      tower: data.tower,
      pickupDate: data.pickup_date,
      materials: data.materials ?? [],
      status: data.status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      actualWeights: data.actual_weights,
      championId: data.champion_id,
      championEmail: booking.championEmail,
      inquiryDate: data.inquiry_date,
      lastCommunicationDate: data.last_communication_date,
      statusComments: data.status_comments,
      source: data.source,
    };

    return res.json(updated);
  } catch (err) {
    console.error("PUT /api/bookings/:id error:", err);
    return res.status(500).json({ error: "Failed to update booking" });
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
      statusComments: parsed.data.statusComments,
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Auto-upsert ERP customer when booking becomes scheduled or completed
    if (parsed.data.status === "scheduled" || parsed.data.status === "completed") {
      upsertERPCustomerFromBooking({
        fullName: booking.fullName,
        phone: booking.phone,
        society: booking.society,
        tower: booking.tower,
      });
    }

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
