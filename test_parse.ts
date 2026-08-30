const mockText = `
The Scrap Co.
Mobile : 7292016625
Email : bookings.scrapco@gmail.com
BILL OF SUPPLY ORIGINAL FOR RECIPIENT
Invoice No. 7
Invoice Date 30/08/2026
Due Date 06/09/2026
BILL TO
Cust2pdf
Mobile : 1239876540
S.NO. ITEMS QTY. RATE AMOUNT
1 BRASS 1 KGS 0 0
2 COPPER 1 KGS 0 0
3 NEWSPAPERS 1 KGS 16 16
4 PLASTICS 4 KGS 14 56
SUBTOTAL 7 ₹ 72
TERMS AND CONDITIONS
.
Total Amount ₹ 72
Received Amount ₹ 0
Total Amount (in words)
Seventy Two Rupees
`;

function parseReceiptText(text: string): Record<string, any> {
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

  const purchaseNoMatch = text.match(/(?:Purchase|Invoice)\s*No\.?\s*[:\-]?\s*([\w\-]+)/i);
  if (purchaseNoMatch) result.purchase_no = purchaseNoMatch[1].trim();

  const dateMatch = text.match(/Purchase\s*Date\s*[:\-]?\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{4})/i)
    ?? text.match(/Date\s*[:\-]?\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{4})/i);
  if (dateMatch) {
    const parts = dateMatch[1].split(/[\/\-]/);
    result.purchase_date = `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
  }

  const billFromIdx = lines.findIndex((l) => /bill\s+(from|to)/i.test(l));
  if (billFromIdx !== -1) {
    const nameLine = lines[billFromIdx + 1];
    if (nameLine && !/mobile|phone|address|₹|\d{10}/i.test(nameLine)) {
      result.customer_name = nameLine;
    }
    for (let i = billFromIdx + 1; i <= Math.min(billFromIdx + 5, lines.length - 1); i++) {
      const mobileMatch = lines[i].match(/(?:\+91[-\s]?)?([6-9]\d{9})/);
      if (mobileMatch) {
        result.customer_mobile = mobileMatch[1];
        break;
      }
    }
  }

  if (!result.customer_mobile) {
    const mobileMatch = text.match(/(?:\+91[-\s]?)?([6-9]\d{9})/);
    if (mobileMatch) result.customer_mobile = mobileMatch[1];
  }

  const addrMatch = text.match(/Address\s*[:\-]?\s*(.+)/i);
  if (addrMatch) result.customer_address = addrMatch[1].trim();

  const itemHeaderIdx = lines.findIndex((l) => /s\.?\s*no/i.test(l) && /item/i.test(l));
  const subtotalIdx   = lines.findIndex((l) => /subtotal|sub\s*total/i.test(l));

  if (itemHeaderIdx !== -1 && subtotalIdx !== -1 && subtotalIdx > itemHeaderIdx) {
    for (let i = itemHeaderIdx + 1; i < subtotalIdx; i++) {
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

  const extractAmount = (label: string): number | null => {
    const rx = new RegExp(`${label}\\s*[:\\-]?\\s*₹?\\s*([\\d,]+\\.?\\d*)`, "i");
    const m = text.match(rx);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };

  result.total_amount   = extractAmount("Total\\s*Amount");
  result.paid_amount    = extractAmount("Paid\\s*Amount") ?? extractAmount("Received\\s*Amount");
  result.balance        = extractAmount("Balance");
  result.subtotal_amount = extractAmount("Sub\\s*[Tt]otal");

  const payMatch = text.match(/Payment\s*Mode\s*[:\-]?\s*(.+)/i);
  if (payMatch) result.payment_mode = payMatch[1].trim().split("\n")[0];

  const notesMatch = text.match(/Notes?\s*[:\-]?\s*(.+)/i);
  if (notesMatch) result.notes = notesMatch[1].trim().split("\n")[0];

  return result;
}

console.log(JSON.stringify(parseReceiptText(mockText), null, 2));
