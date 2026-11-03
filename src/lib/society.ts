// Societies (apartment complexes) we collect from. Used to suggest a customer's
// society from their address. Keep in step with SOCIETIES on the home page
// (frontend_scrapco/src/routes/index.tsx); names seen on bills are added here too.
export const KNOWN_SOCIETIES = [
  "Gaur City 1",
  "Gaur City 2",
  "Mahagun Mywoods",
  "Panchsheel Greens 2",
  "Supertech Eco Village 1",
  "Nirala Estate",
  "Fusion Homes",
  "Spring Homes",
  "ATS Happy Trails",
  "Ace Divino",
  "CRC Joyous",
  "Gulshan Bellina",
  "Ace City",
  "Ajnara Le Garden",
  "Ajnara Homes",
  "Panchsheel Hynish",
  "Renox Thrive",
  "Lotus Panache",
  "Parx Laureate",
  "Galaxy Vega",
  "Oxford Square",
  "Cherry County",
  "Unitech Horizon",
  "Divine Meadows",
];

export const LEAD_SOURCES = [
  "WhatsApp",
  "Referral",
  "Society notice / flyer",
  "Website booking",
  "Repeat customer",
  "Walk-in",
  "Other",
] as const;

// "Ajnara Homes-121", "ajnara  homes" and "AJNARA HOMES" all give "ajnarahomes"
export function societyKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// The society whose name appears in the address. Longer names win, so
// "Ajnara Le Garden" is not reported as a shorter society that it contains.
// `extra` adds societies already saved on customers.
export function detectSociety(address: string | null | undefined, extra: string[] = []): string | null {
  if (!address) return null;
  const key = societyKey(address);
  if (!key) return null;
  const names = [...new Set([...KNOWN_SOCIETIES, ...extra.filter(Boolean)])]
    .map((name) => ({ name, k: societyKey(name) }))
    .filter((n) => n.k.length >= 4)
    .sort((a, b) => b.k.length - a.k.length);
  return names.find((n) => key.includes(n.k))?.name ?? null;
}
