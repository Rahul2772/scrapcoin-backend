import { createClient } from "@supabase/supabase-js";
import type { Booking, ScrapCategory } from "../types.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// ── Categories ──────────────────────────────────────────

export async function getCategories(): Promise<ScrapCategory[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("*");

  if (error) throw new Error(error.message);

  return data.map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit as "kg",
    pricePerUnit: Number(r.price_per_unit),
  }));
}

// ── Bookings ─────────────────────────────────────────────

export async function getBookings(): Promise<Booking[]> {
  const { data, error } = await supabase
    .from("bookings")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data.map(rowToBooking);
}

export async function saveBooking(booking: Booking): Promise<Booking> {
  const { error } = await supabase.from("bookings").insert({
    id: booking.id,
    full_name: booking.fullName,
    phone: booking.phone,
    society: booking.society,
    tower: booking.tower ?? null,
    pickup_date: booking.pickupDate,
    materials: booking.materials,
    status: booking.status,
    created_at: booking.createdAt,
    updated_at: booking.updatedAt,
  });

  if (error) throw new Error(error.message);
  return booking;
}

export async function getBookingById(id: string): Promise<Booking | undefined> {
  const { data, error } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    if (error.code === "PGRST116") return undefined; // not found
    throw new Error(error.message);
  }

  return rowToBooking(data);
}

// ── Helper ────────────────────────────────────────────────

function rowToBooking(r: Record<string, unknown>): Booking {
  return {
    id: r.id as string,
    fullName: r.full_name as string,
    phone: r.phone as string,
    society: r.society as string,
    tower: r.tower as string | undefined,
    pickupDate: r.pickup_date as string,
    materials: r.materials as string[],
    status: r.status as Booking["status"],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}