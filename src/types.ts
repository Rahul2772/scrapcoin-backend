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
