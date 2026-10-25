export interface ExpenseCategoryItem {
  value: string;
  name: string;
  label: string;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategoryItem[] = [
  { value: "marketing_offline",  name: "Marketing – Offline",            label: "Marketing – Offline" },
  { value: "marketing_online",   name: "Marketing – Online",             label: "Marketing – Online" },
  { value: "internet_telecom",   name: "Internet & Telecommunication",  label: "Internet & Telecommunication" },
  { value: "subscription",       name: "Subscription",                  label: "Subscription" },
  { value: "travel",             name: "Travel",                        label: "Travel" },
  { value: "transport",          name: "Transport",                     label: "Transport" },
  { value: "print",              name: "Print",                         label: "Print" },
  { value: "rent",               name: "Rent",                          label: "Rent" },
  { value: "miscellaneous",      name: "Miscellaneous",                 label: "Miscellaneous" },
] as const;

export const LEGACY_EXPENSE_CATEGORIES: readonly ExpenseCategoryItem[] = [
  { value: "marketing", name: "Marketing", label: "Marketing (legacy)" },
] as const;

export function isLegacyCategoryName(name?: string | null): boolean {
  if (!name) return false;
  return name.trim().toLowerCase() === "marketing";
}
