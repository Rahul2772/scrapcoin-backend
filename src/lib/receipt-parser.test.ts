import test from "node:test";
import assert from "node:assert/strict";
import { parseReceiptText, extractBillToAddress } from "./receipt-parser.js";

const HEADER = `The Scrap Co.
Mobile : 7292016625
Email : bookings.scrapco@gmail.com
PURCHASE
Purchase No. 40
Purchase Date 01/11/2026`;

const ITEMS = `S.NO. ITEMS QTY. RATE AMOUNT
1 NEWSPAPERS 4.335 KGS 15 65.03
2 STEEL 1.124 KGS 42 47.21
SUBTOTAL 5.459 ₹ 112.24
Total Amount ₹ 112.24
Paid Amount ₹ 112.24
Balance ₹ 0`;

test("unlabelled address between name and mobile (receipt #40 layout)", () => {
  const parsed = parseReceiptText(`${HEADER}
BILL TO
Deepak Sharma
Tower 2A - 1902 Ace Parkville Sector 150 Gautam Buddha Nagar Uttar Pradesh 201304
Mobile : 9818648638
${ITEMS}`);
  assert.equal(parsed.customer_name, "Deepak Sharma");
  assert.equal(parsed.customer_mobile, "9818648638");
  assert.equal(parsed.customer_address, "Tower 2A - 1902 Ace Parkville Sector 150 Gautam Buddha Nagar Uttar Pradesh 201304");
  assert.equal(parsed.line_items.length, 2);
});

test("unlabelled address wrapped over several lines, pincode on its own line", () => {
  const parsed = parseReceiptText(`${HEADER}
BILL TO
Deepak Sharma
Tower 2A - 1902, Ace Parkville,
Sector 150, Gautam Buddha Nagar
Uttar Pradesh
201304
Mobile : 9818648638
${ITEMS}`);
  assert.equal(parsed.customer_address, "Tower 2A - 1902, Ace Parkville, Sector 150, Gautam Buddha Nagar, Uttar Pradesh, 201304");
});

test("labelled address with continuation line", () => {
  const parsed = parseReceiptText(`${HEADER}
BILL TO
Priya Verma
Mobile : 9876543210
Address : H-12, Sector 62
Noida, Uttar Pradesh
${ITEMS}`);
  assert.equal(parsed.customer_mobile, "9876543210");
  assert.equal(parsed.customer_address, "H-12, Sector 62, Noida, Uttar Pradesh");
});

test("no address on receipt → null (mobile right after name)", () => {
  const parsed = parseReceiptText(`${HEADER}
BILL TO
Cust2pdf
Mobile : 1239876540
${ITEMS}`);
  assert.equal(parsed.customer_name, "Cust2pdf");
  assert.equal(parsed.customer_address, null);
});

test("business address in the header is never used as the customer's", () => {
  const parsed = parseReceiptText(`The Scrap Co.
Address : Plot 7, Sector 18, Noida
Mobile : 7292016625
BILL TO
Amit Kumar
Mobile : 9000000001
${ITEMS}`);
  assert.equal(parsed.customer_address, null);
});

test("address line starting with a word like 'State' is kept", () => {
  const lines = ["BILL TO", "Ravi", "State Bank Colony, Block C", "Mobile : 9000000002"];
  assert.equal(extractBillToAddress(lines, 0), "State Bank Colony, Block C");
});

test("address stops at the items table when there is no mobile line", () => {
  const lines = ["BILL TO", "Ravi", "Sector 21, Gurgaon", "S.NO. ITEMS QTY. RATE AMOUNT", "1 STEEL 2 KGS 40 80"];
  assert.equal(extractBillToAddress(lines, 0), "Sector 21, Gurgaon");
});
