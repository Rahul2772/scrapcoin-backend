/**
 * Parses the text of a ScrapCo purchase receipt PDF (sent via Telegram) into
 * structured fields. Kept free of I/O so it can be unit-tested.
 */

/** Normalize phone number → last 10 digits for consistent matching */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-10);
}

/** Parse the raw PDF text against the ScrapCo receipt format */
export function parseReceiptText(text: string): Record<string, any> {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const result: Record<string, any> = {
    purchase_no:     null,
    purchase_date:   null,
    customer_name:   null,
    customer_mobile: null,
    customer_address: null,
    line_items:      [],
    subtotal_amount: null,
    total_amount:    null,
    paid_amount:     null,
    balance:         null,
    payment_mode:    null,
    notes:           null,
  };

  // ── Purchase No ─────────────────────────────────────────────────────────────
  const purchaseNoMatch = text.match(/(?:Purchase|Invoice)\s*No\.?\s*[:\-]?\s*([\w\-]+)/i);
  if (purchaseNoMatch) result.purchase_no = purchaseNoMatch[1].trim();

  // ── Date ─────────────────────────────────────────────────────────────────────
  // Formats: 04/07/2026  or  04-07-2026  or  4 Jul 2026
  const dateMatch = text.match(/Purchase\s*Date\s*[:\-]?\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{4})/i)
    ?? text.match(/Date\s*[:\-]?\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{4})/i);
  if (dateMatch) {
    const parts = dateMatch[1].split(/[\/\-]/);
    // dd/mm/yyyy → yyyy-mm-dd
    result.purchase_date = `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
  }

  // ── Customer Name & Mobile ────────────────────────────────────────────────
  // Receipt says "Bill From" or "Bill To" section
  const billFromIdx = lines.findIndex((l) => /bill\s+(from|to)/i.test(l));
  if (billFromIdx !== -1) {
    // Next non-empty line after "BILL TO" is the customer name
    const nameLine = lines[billFromIdx + 1];
    if (nameLine && !/mobile|phone|address|₹/i.test(nameLine)) {
      result.customer_name = nameLine;
    }
    // Look for a 10-digit mobile in the BILL TO section (within 8 lines)
    for (let i = billFromIdx + 1; i <= Math.min(billFromIdx + 8, lines.length - 1); i++) {
      // Strip known label prefixes like "Mobile :" or "Phone:" before matching
      const cleanLine = lines[i].replace(/^(mobile|phone)\s*[:\-]?\s*/i, '');
      const mobileMatch = cleanLine.match(/(\d{10})/);
      if (mobileMatch) {
        result.customer_mobile = mobileMatch[1];
        break;
      }
    }

    result.customer_address = extractBillToAddress(lines, billFromIdx);
  }
  // NOTE: No global fallback scan for mobile or address — it would pick up The Scrap Co.'s own
  // business details from the header.

  // ── Items table ────────────────────────────────────────────────────────────
  // Look for lines between "S.NO / ITEMS" header and subtotal
  const itemHeaderIdx = lines.findIndex((l) => /s\.?\s*no/i.test(l) && /item/i.test(l));
  const subtotalIdx   = lines.findIndex((l) => /subtotal|sub\s*total/i.test(l));

  if (itemHeaderIdx !== -1 && subtotalIdx !== -1 && subtotalIdx > itemHeaderIdx) {
    for (let i = itemHeaderIdx + 1; i < subtotalIdx; i++) {
      // Each item line pattern: [sno] [name] [qty unit] [rate] [amount]
      // e.g.  "1 Newspaper 5 KG 10.00 50.00"
      const itemMatch = lines[i].match(
        /^(\d+)\s+(.+?)\s+([\d.]+)\s*(KG|KGS|PC|PCS|NOS?|LTR?)\s+([\d.]+)\s+([\d.]+)\s*$/i
      );
      if (itemMatch) {
        result.line_items.push({
          sno:       parseInt(itemMatch[1]),
          item_name: itemMatch[2].trim(),
          qty:       parseFloat(itemMatch[3]),
          unit:      itemMatch[4].toUpperCase(),
          rate:      parseFloat(itemMatch[5]),
          amount:    parseFloat(itemMatch[6]),
        });
      }
    }
  }

  // ── Amounts ───────────────────────────────────────────────────────────────
  const extractAmount = (label: string): number | null => {
    const rx = new RegExp(`${label}\\s*[:\\-]?\\s*₹?\\s*([\\d,]+\\.?\\d*)`, "i");
    const m = text.match(rx);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };

  result.total_amount   = extractAmount("Total\\s*Amount");
  result.paid_amount    = extractAmount("Paid\\s*Amount");
  result.balance        = extractAmount("Balance");
  result.subtotal_amount = extractAmount("Sub\\s*[Tt]otal");

  // ── Payment mode & Notes ──────────────────────────────────────────────────
  const payMatch = text.match(/Payment\s*Mode\s*[:\-]?\s*(.+)/i);
  if (payMatch) result.payment_mode = payMatch[1].trim().split("\n")[0];

  const notesMatch = text.match(/Notes?\s*[:\-]?\s*(.+)/i);
  if (notesMatch) result.notes = notesMatch[1].trim().split("\n")[0];

  return result;
}

/** Confidence check: must have total_amount, paid_amount, and ≥1 line item */
export function isHighConfidence(parsed: Record<string, any>): boolean {
  return (
    parsed.total_amount !== null &&
    parsed.paid_amount  !== null &&
    Array.isArray(parsed.line_items) &&
    parsed.line_items.length > 0
  );
}

// Lines that start a new field (or the items table) end the BILL TO address.
// Words that can also begin a real address line ("State Bank Colony") only count with a ":" / "-".
const ADDRESS_STOP = /^(mobile|mob\b|phone|ph\b|email|e-mail|gstin|s\.?\s*no|sr\.?\s*no|items?\b|qty\b|subtotal|sub\s*total|total\s+amount|bill\s+(from|to)|ship\s+to)/i;
const ADDRESS_STOP_LABEL = /^(contact|gst|pan|state|place\s+of\s+supply|payment(\s+mode)?|notes?|terms|invoice(\s+no\.?)?|purchase(\s+no\.?)?|due\s+date|date)\s*[:\-]/i;

function isAddressStop(line: string): boolean {
  if (ADDRESS_STOP.test(line) || ADDRESS_STOP_LABEL.test(line)) return true;
  if (/₹/.test(line)) return true;
  // A bare phone number, a serial-number cell, or a price — but not a 6-digit pincode
  if (/^\+?[\d\s\-()]{10,}$/.test(line) || /^\d{1,3}$/.test(line) || /^\d+\.\d+$/.test(line)) return true;
  return false;
}

/** Join wrapped address lines; avoid doubling commas when a line already ends with one */
function joinAddressLines(parts: string[]): string {
  return parts
    .reduce((acc, part) => (acc === "" ? part : /[,\-\/]$/.test(acc) ? `${acc} ${part}` : `${acc}, ${part}`), "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Customer address inside the BILL TO / BILL FROM section. Supports both
 *   "Address : <text>" (optionally continued on following lines), and
 *   an unlabelled address printed between the customer name and the Mobile line.
 * Never looks outside the section, so the business's own header address is never used.
 */
export function extractBillToAddress(lines: string[], billIdx: number): string | null {
  const sectionEnd = Math.min(billIdx + 10, lines.length - 1);
  const MAX_ADDRESS_LINES = 5;

  // 1. Labelled: "Address : ..."
  for (let i = billIdx + 1; i <= sectionEnd; i++) {
    if (!/^address\b\s*[:\-]?/i.test(lines[i])) continue;

    const parts: string[] = [];
    const inline = lines[i].replace(/^address\b\s*[:\-]?\s*/i, "").trim();
    if (inline) parts.push(inline);
    for (let j = i + 1; j <= Math.min(i + MAX_ADDRESS_LINES, lines.length - 1); j++) {
      if (isAddressStop(lines[j])) break;
      parts.push(lines[j]);
    }
    return parts.length > 0 ? joinAddressLines(parts) : null;
  }

  // 2. Unlabelled: lines after the customer name, up to the first field label
  const nameIdx = billIdx + 1;
  if (nameIdx >= lines.length || isAddressStop(lines[nameIdx])) return null;

  const parts: string[] = [];
  for (let j = nameIdx + 1; j <= Math.min(nameIdx + MAX_ADDRESS_LINES, lines.length - 1); j++) {
    if (isAddressStop(lines[j])) break;
    parts.push(lines[j]);
  }
  return parts.length > 0 ? joinAddressLines(parts) : null;
}

