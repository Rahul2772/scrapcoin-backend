import type { Booking, BookingStatus, ScrapCategory } from "../types.js";
import { supabase } from "../lib/supabase.js";

// ── Categories ──────────────────────────────────────────

export async function getCategories(): Promise<ScrapCategory[]> {
  const { data, error } = await supabase.from("categories").select("*");
  if (error) throw new Error(error.message);
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit as "kg",
    pricePerUnit: Number(r.price_per_unit),
  }));
}

export async function createCategory(input: {
  id: string;
  name: string;
  unit: string;
  price_per_unit: number;
}): Promise<ScrapCategory> {
  const { data, error } = await supabase
    .from("categories")
    .insert(input)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return {
    id: data.id,
    name: data.name,
    unit: data.unit as "kg",
    pricePerUnit: Number(data.price_per_unit),
  };
}

export async function updateCategory(
  id: string,
  input: { name?: string; unit?: string; price_per_unit?: number }
): Promise<ScrapCategory | undefined> {
  const { data, error } = await supabase
    .from("categories")
    .update(input)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    if (error.code === "PGRST116") return undefined;
    throw new Error(error.message);
  }
  return {
    id: data.id,
    name: data.name,
    unit: data.unit as "kg",
    pricePerUnit: Number(data.price_per_unit),
  };
}

export async function deleteCategory(id: string): Promise<void> {
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw new Error(error.message);
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
    if (error.code === "PGRST116") return undefined;
    throw new Error(error.message);
  }
  return rowToBooking(data);
}

export async function updateBookingStatus(
  id: string,
  status: BookingStatus
): Promise<Booking | undefined> {
  const { data, error } = await supabase
    .from("bookings")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) {
    if (error.code === "PGRST116") return undefined;
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