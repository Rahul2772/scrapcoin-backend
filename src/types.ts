export type BookingStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export type ScrapCategory = {
  id: string;
  name: string;
  unit: "kg";
  pricePerUnit: number;
};

export type Booking = {
  id: string;
  fullName: string;
  phone: string;
  society: string;
  tower?: string;
  pickupDate: string;
  materials: string[];
  status: BookingStatus;
  createdAt: string;
  updatedAt: string;
  userId?: string;
  actualWeights?: Record<string, number>;
  championId?: string;
  championEmail?: string;
  // CRM fields (admin manual entry from WhatsApp)
  inquiryDate?: string | null;
  lastCommunicationDate?: string | null;
  statusComments?: string | null;
  source?: "website" | "whatsapp" | "admin";
};

export type LivePickupItem = {
  label: string;
  weightKg: number;
  categoryId: string;
};

export type LivePickup = {
  id: string;
  location: string;
  status: "in_progress" | "completed";
  items: LivePickupItem[];
  payoutAmount: number;
  currency: "INR";
};
