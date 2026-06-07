import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Booking, ScrapCategory } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../data");
const BOOKINGS_FILE = join(DATA_DIR, "bookings.json");
const CATEGORIES_FILE = join(DATA_DIR, "categories.json");

const DEFAULT_CATEGORIES: ScrapCategory[] = [
  { id: "cardboard", name: "Paper / Cardboard", unit: "kg", pricePerUnit: 12 },
  { id: "plastics", name: "Plastics", unit: "kg", pricePerUnit: 18 },
  { id: "metals", name: "Metals", unit: "kg", pricePerUnit: 35 },
  { id: "e-waste", name: "E-Waste", unit: "kg", pricePerUnit: 22 },
  { id: "others", name: "Others", unit: "kg", pricePerUnit: 10 },
];

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  ensureDataDir();
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf-8");
    return fallback;
  }
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function writeJson<T>(filePath: string, data: T) {
  ensureDataDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function getCategories(): ScrapCategory[] {
  return readJson(CATEGORIES_FILE, DEFAULT_CATEGORIES);
}

export function getBookings(): Booking[] {
  return readJson<Booking[]>(BOOKINGS_FILE, []);
}

export function saveBooking(booking: Booking): Booking {
  const bookings = getBookings();
  bookings.unshift(booking);
  writeJson(BOOKINGS_FILE, bookings);
  return booking;
}

export function getBookingById(id: string): Booking | undefined {
  return getBookings().find((b) => b.id === id);
}
