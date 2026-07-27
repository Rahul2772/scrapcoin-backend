export const SUPPORTED_PINCODES = new Set([
  "201301",
  "201303",
  "201304",
  "201305",
  "201306",
  "201307",
  "201308",
  "201309",
  "201310",
  "201312",
  "201313",
  "201318",
  "203207",
  "201010",
  "201014",
]);

export function isPincodeSupported(pincode: string): boolean {
  if (!pincode) return false;
  return SUPPORTED_PINCODES.has(pincode.trim());
}
