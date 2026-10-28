/**
 * Telegram Receipt Ingestion Route
 * POST  /api/telegram/webhook              — receives Telegram updates (PDF receipts)
 * GET   /api/telegram/receipts             — list ingested receipts (admin)
 * PATCH /api/telegram/receipts/:id         — save edits to parsed fields before approving
 * PATCH /api/telegram/receipts/:id/verify  — approve → creates real erp_purchase_receipts
 * PATCH /api/telegram/receipts/:id/reject  — admin rejects
 * GET   /api/telegram/receipts/:id/pdf     — signed URL to original PDF
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { requireAdminOrChampion } from "../middleware/requireAdminOrChampion.js";
// pdf-parse is a CJS module — import via createRequire for ESM compatibility
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

function render_page(pageData: any) {
  let render_options = { normalizeWhitespace: false, disableCombineTextItems: false };
  return pageData.getTextContent(render_options).then(function(textContent: any) {
      let lastY = -1;
      let lastX = -1;
      let lastW = 0;
      let text = '';
      for (let item of textContent.items) {
          let currentX = item.transform[4];
          let currentY = item.transform[5];
          let width = item.width;
          
          if (lastY == currentY || !lastY) {
              if (lastX !== -1 && (currentX - (lastX + lastW)) > 5) {
                  text += ' ' + item.str;
              } else {
                  text += item.str;
              }
          } else {
              text += '\n' + item.str;
          }
          lastY = currentY;
          lastX = currentX;
          lastW = width;
      }
      return text;
  });
}

export const telegramRouter = Router();

// ── Env vars ──────────────────────────────────────────────────────────────────
const BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ALLOWED_SENDER   = process.env.TELEGRAM_ALLOWED_SENDER_ID ?? "";
const WEBHOOK_SECRET   = process.env.TELEGRAM_WEBHOOK_SECRET ?? ""; // may be empty initially
const TELEGRAM_API     = `https://api.telegram.org/bot${BOT_TOKEN}`;
const STORAGE_BUCKET   = "invoices"; // reuse existing bucket

/** Ensure the invoices storage bucket exists in Supabase */
async function ensureStorageBucket(): Promise<boolean> {
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) {
      console.warn("[Telegram] Error listing storage buckets:", error.message);
      return false;
    }
    const exists = (buckets ?? []).some((b) => b.name === STORAGE_BUCKET);
    if (!exists) {
      const { error: createErr } = await supabase.storage.createBucket(STORAGE_BUCKET, {
        public: true,
      });
      if (createErr) {
        console.warn(`[Telegram] Could not auto-create bucket "${STORAGE_BUCKET}":`, createErr.message);
        return false;
      }
      console.log(`[Telegram] Created storage bucket "${STORAGE_BUCKET}" successfully.`);
    }
    return true;
  } catch (err: any) {
    console.warn("[Telegram] ensureStorageBucket exception:", err.message);
    return false;
  }
}
// Run once on load
ensureStorageBucket().catch(() => {});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send a Telegram message back to the trusted sender */
async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.error("[Telegram] sendMessage failed:", err);
  }
}

/** Normalize phone number → last 10 digits for consistent matching */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-10);
}

/** Parse the raw PDF text against the ScrapCo receipt format */
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

    // ── Address: look within the BILL TO section (within 10 lines of section header)
    // Collect address lines — may span multiple lines (e.g. tower, street, city)
    const addrLabelIdx = (() => {
      for (let i = billFromIdx + 1; i <= Math.min(billFromIdx + 10, lines.length - 1); i++) {
        if (/^address\s*[:\-]?/i.test(lines[i])) return i;
      }
      return -1;
    })();

    if (addrLabelIdx !== -1) {
      const addrParts: string[] = [];
      // Inline value on the "Address:" line itself (after the label)
      const inlineAddr = lines[addrLabelIdx].replace(/^address\s*[:\-]?\s*/i, '').trim();
      if (inlineAddr) addrParts.push(inlineAddr);

      // Collect continuation lines until we hit a known stop pattern
      for (let i = addrLabelIdx + 1; i <= Math.min(addrLabelIdx + 5, lines.length - 1); i++) {
        const ln = lines[i];
        // Stop at field labels (mobile, phone, email, payment, S.No, bill section, etc.)
        if (/^(mobile|phone|email|payment|s\.?no|item|qty|rate|amount|subtotal|total|bill|notes?)\b/i.test(ln)) break;
        // Stop if line is just digits (could be a number column or section divider)
        if (/^\d+$/.test(ln)) break;
        // Stop if line contains price-like patterns (₹ or decimals)
        if (/₹|^\d+\.\d{2}$/.test(ln)) break;
        addrParts.push(ln);
      }

      if (addrParts.length > 0) {
        result.customer_address = addrParts.join(', ').trim();
      }
    }
  }
  // NOTE: No global fallback scan for mobile — it would pick up The Scrap Co.'s own business number

  // ── Address fallback: if not found in BILL TO section, try global search ──
  // (handles receipts where address appears outside a bill section)
  if (!result.customer_address) {
    const globalAddrMatch = text.match(/Address\s*[:\-]?\s*(.+)/i);
    if (globalAddrMatch) {
      result.customer_address = globalAddrMatch[1].trim();
    }
  }

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
function isHighConfidence(parsed: Record<string, any>): boolean {
  return (
    parsed.total_amount !== null &&
    parsed.paid_amount  !== null &&
    Array.isArray(parsed.line_items) &&
    parsed.line_items.length > 0
  );
}

// ── POST /api/telegram/webhook ────────────────────────────────────────────────
telegramRouter.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  // Phase 1 — Secret header check (skip if not configured yet)
  if (WEBHOOK_SECRET) {
    const incoming = req.headers["x-telegram-bot-api-secret-token"];
    if (incoming !== WEBHOOK_SECRET) {
      console.warn("[Telegram] Webhook secret mismatch — ignoring");
      res.sendStatus(200);
      return;
    }
  }

  // Always respond 200 immediately to prevent Telegram retries
  res.sendStatus(200);

  // ── Async processing ────────────────────────────────────────────────────────
  try {
    const body = req.body as any;
    const message = body?.message;
    if (!message) return;

    const chatId   = message.chat?.id;
    const senderId = String(message.from?.id ?? "");

    // Phase 2 — Sender whitelist
    if (senderId !== String(ALLOWED_SENDER)) {
      console.warn(`[Telegram] Unauthorized sender: ${senderId}`);
      return;
    }

    // Phase 3 — Must be a PDF document
    const doc = message.document;
    if (!doc || doc.mime_type !== "application/pdf") {
      await sendTelegramMessage(chatId, "⚠️ Please send the receipt as a <b>PDF file</b>.");
      return;
    }

    // Phase 4 — Download the PDF
    const fileInfoRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${doc.file_id}`);
    const fileInfo    = (await fileInfoRes.json()) as any;
    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      await sendTelegramMessage(chatId, "❌ Could not retrieve the file from Telegram. Please resend.");
      return;
    }

    const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) {
      await sendTelegramMessage(chatId, "❌ PDF download failed. Please resend.");
      return;
    }

    const pdfBuffer = Buffer.from(await fileResp.arrayBuffer());

    // Phase 5 — Parse PDF
    let rawText = "";
    let parsed: Record<string, any> = {};
    let parseFailed = false;
    try {
      const pdfData = await pdfParse(pdfBuffer, { pagerender: render_page });
      rawText = pdfData.text ?? "";
      parsed  = parseReceiptText(rawText);
    } catch (parseErr) {
      console.error("[Telegram] PDF parse error:", parseErr);
      parseFailed = true;
    }

    const highConf = isHighConfidence(parsed);

    // Phase 6 — Customer lookup / creation
    let customerId: string | null = null;
    let customerStatus: "matched" | "created" | "none" = "none";

    if (parsed.customer_mobile) {
      const normalizedPhone = normalizePhone(parsed.customer_mobile);

      // Fetch all customers and normalize their phones for matching
      const { data: allCustomers } = await supabase
        .from("erp_customers")
        .select("id, name, phone")
        .eq("is_active", true);

      const match = (allCustomers ?? []).find(
        (c) => c.phone && normalizePhone(c.phone) === normalizedPhone
      );

      if (match) {
        customerId     = match.id;
        customerStatus = "matched";
      } else if (parsed.customer_name) {
        // Create new customer flagged as telegram_auto
        const { data: newCust, error: custErr } = await supabase
          .from("erp_customers")
          .insert({
            name:       parsed.customer_name,
            phone:      parsed.customer_mobile,
            address:    parsed.customer_address ?? null,
            created_via: "telegram_auto",
            is_active:  true,
          })
          .select("id")
          .single();

        if (!custErr && newCust) {
          customerId     = newCust.id;
          customerStatus = "created";
        }
      }
    }

    // Phase 7 — Insert receipt as pending_review
    const { data: receiptRow, error: insertErr } = await supabase
      .from("telegram_ingested_receipts")
      .insert({
        source:             "telegram",
        status:             "pending_review",
        customer_id:        customerId,
        purchase_no:        parsed.purchase_no   ?? null,
        purchase_date:      parsed.purchase_date ?? null,
        customer_name:      parsed.customer_name ?? null,
        customer_mobile:    parsed.customer_mobile ?? null,
        customer_address:   parsed.customer_address ?? null,
        line_items:         parsed.line_items ?? [],
        subtotal_amount:    parsed.subtotal_amount ?? null,
        total_amount:       parsed.total_amount ?? null,
        paid_amount:        parsed.paid_amount ?? null,
        balance:            parsed.balance ?? null,
        payment_mode:       parsed.payment_mode ?? null,
        notes:              parsed.notes ?? null,
        raw_extracted_text: rawText,
        pdf_storage_path:   null, // will update after upload
      })
      .select("id")
      .single();

    if (insertErr || !receiptRow) {
      console.error("[Telegram] DB insert failed:", insertErr);
      await sendTelegramMessage(chatId, "❌ Failed to log receipt. Please notify admin.");
      return;
    }

    // Phase 8 — Upload PDF to Supabase Storage
    await ensureStorageBucket();
    const storagePath = `telegram/${receiptRow.id}.pdf`;
    const { error: storageErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (!storageErr) {
      await supabase
        .from("telegram_ingested_receipts")
        .update({ pdf_storage_path: storagePath })
        .eq("id", receiptRow.id);
    } else {
      console.error("[Telegram] Storage upload failed:", storageErr.message);
    }

    // Phase 9 — Reply to sender
    if (parseFailed) {
      await sendTelegramMessage(
        chatId,
        "⚠️ Could not read the PDF text. The receipt has been saved and flagged for manual admin entry."
      );
    } else {
      const amtStr     = parsed.total_amount != null ? `₹${parsed.total_amount.toLocaleString("en-IN")}` : "amount unknown";
      const itemsStr   = parsed.line_items?.length ? `${parsed.line_items.length} item(s)` : "items unreadable";
      const custStr    = parsed.customer_name ?? "Unknown customer";
      const custStatus = customerStatus === "matched"
        ? "(existing customer)"
        : customerStatus === "created"
        ? "(⚠️ NEW customer — admin will verify)"
        : "(customer not matched)";
      const confNote   = highConf ? "" : "\n⚠️ <i>Low confidence parse — admin review required.</i>";

      await sendTelegramMessage(
        chatId,
        `✅ Receipt logged (pending verification)\n` +
        `Amount: <b>${amtStr}</b> — ${itemsStr}\n` +
        `Customer: <b>${custStr}</b> ${custStatus}` +
        confNote
      );
    }
  } catch (err: any) {
    console.error("[Telegram] Webhook processing error:", err?.message ?? err);
  }
});

// ── GET /api/telegram/receipts ────────────────────────────────────────────────
telegramRouter.get(
  "/receipts",
  requireAdminOrChampion,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const status = (req.query.status as string) ?? undefined;

      let query = supabase
        .from("telegram_ingested_receipts")
        .select("*, erp_customers(name, phone, address)")
        .order("created_at", { ascending: false });

      if (status) query = query.eq("status", status);

      const { data, error } = await query;
      if (error) throw error;

      res.json({ success: true, receipts: data ?? [] });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── Zod schema for editing a Telegram receipt ────────────────────────────────
const tgEditSchema = z.object({
  customer_name:    z.string().trim().optional(),
  customer_mobile:  z.string().trim().optional(),
  customer_address: z.string().trim().optional().nullable(),
  purchase_date:    z.string().trim().optional().nullable(),
  payment_mode:     z.string().trim().optional().nullable(),
  notes:            z.string().trim().optional().nullable(),
  line_items: z.array(z.object({
    item_name: z.string().trim().min(1, "Item name required"),
    qty:       z.number().positive("Qty must be > 0"),
    unit:      z.string().trim().optional().default("KG"),
    rate:      z.number().nonnegative("Rate must be >= 0"),
    amount:    z.number().optional(), // will be recalculated server-side
  })).min(1, "At least one line item is required").optional(),
});

// ── PATCH /api/telegram/receipts/:id — Save edits before approving ───────────
telegramRouter.patch(
  "/receipts/:id",
  requireAdminOrChampion,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;

      // 1. Only allow editing pending_review receipts
      const { data: existing, error: fetchErr } = await supabase
        .from("telegram_ingested_receipts")
        .select("status")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) {
        res.status(404).json({ success: false, message: "Receipt not found." });
        return;
      }
      if (existing.status !== "pending_review") {
        res.status(409).json({ success: false, message: `Cannot edit a receipt that is already ${existing.status}.` });
        return;
      }

      // 2. Validate body
      const parsed = tgEditSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ success: false, errors: parsed.error.flatten() });
        return;
      }

      const updates: Record<string, any> = {};
      const d = parsed.data;

      if (d.customer_name !== undefined)    updates.customer_name    = d.customer_name;
      if (d.customer_mobile !== undefined)  updates.customer_mobile  = d.customer_mobile;
      if (d.customer_address !== undefined) updates.customer_address = d.customer_address;
      if (d.purchase_date !== undefined)    updates.purchase_date    = d.purchase_date;
      if (d.payment_mode !== undefined)     updates.payment_mode     = d.payment_mode;
      if (d.notes !== undefined)            updates.notes            = d.notes;

      // 3. If line_items provided, recalculate totals server-side
      if (d.line_items) {
        const recalculated = d.line_items.map((item, idx) => ({
          ...item,
          sno: idx + 1,
          amount: Number((item.qty * item.rate).toFixed(2)),
        }));
        const subtotal = recalculated.reduce((s, i) => s + i.amount, 0);
        updates.line_items      = recalculated;
        updates.subtotal_amount = subtotal;
        updates.total_amount    = subtotal;
      }

      if (Object.keys(updates).length === 0) {
        res.json({ success: true, message: "No changes to save." });
        return;
      }

      // 4. Apply update
      const { error: updateErr } = await supabase
        .from("telegram_ingested_receipts")
        .update(updates)
        .eq("id", id);

      if (updateErr) throw updateErr;

      res.json({ success: true, message: "Receipt updated." });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── PATCH /api/telegram/receipts/:id/verify ──────────────────────────────────
// Approves a Telegram receipt → creates real erp_purchase_receipts rows
telegramRouter.patch(
  "/receipts/:id/verify",
  requireAdminOrChampion,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const adminId = req.privilegedUser?.id;

      // 1. Fetch the telegram receipt (reads whatever edits were saved)
      const { data: tgReceipt, error: fetchErr } = await supabase
        .from("telegram_ingested_receipts")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchErr || !tgReceipt) {
        res.status(404).json({ success: false, message: "Receipt not found." });
        return;
      }

      // 2. Double-approval guard
      if (tgReceipt.purchase_receipt_id) {
        res.status(409).json({ success: false, message: "This receipt has already been approved and linked to a real receipt. Cannot approve again." });
        return;
      }
      if (tgReceipt.status === "verified") {
        res.status(409).json({ success: false, message: "This receipt is already verified." });
        return;
      }

      const lineItems = tgReceipt.line_items || [];
      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        res.status(400).json({ success: false, message: "Cannot verify a receipt with no items. Please edit and add items first." });
        return;
      }

      // 3. Resolve customer: use existing customer_id, or auto-create from parsed fields
      let customerId = tgReceipt.customer_id;
      if (!customerId && tgReceipt.customer_mobile) {
        const normalizedPhone = normalizePhone(tgReceipt.customer_mobile);

        // Check for existing customer by phone
        const { data: allCustomers } = await supabase
          .from("erp_customers")
          .select("id, phone, address")
          .eq("is_active", true);

        const match = (allCustomers ?? []).find(
          (c) => c.phone && normalizePhone(c.phone) === normalizedPhone
        );

        if (match) {
          customerId = match.id;
          // Always update address if receipt has one (fills blank, or refreshes with latest)
          if (tgReceipt.customer_address) {
            await supabase
              .from("erp_customers")
              .update({ address: tgReceipt.customer_address })
              .eq("id", match.id);
          }
        } else if (tgReceipt.customer_name) {
          // Auto-create customer
          const { data: newCust, error: custErr } = await supabase
            .from("erp_customers")
            .insert({
              name:        tgReceipt.customer_name,
              phone:       tgReceipt.customer_mobile,
              address:     tgReceipt.customer_address ?? null,
              created_via: "telegram_auto",
              is_active:   true,
            })
            .select("id")
            .single();

          if (!custErr && newCust) {
            customerId = newCust.id;
          }
        }
      }

      // 4. Map line items to material IDs via fuzzy match
      const { data: allMaterials, error: matErr } = await supabase
        .from("erp_materials")
        .select("id, name, unit, stock_qty");

      if (matErr || !allMaterials) throw new Error("Failed to fetch materials catalog.");

      const newReceiptRows: any[] = [];
      const invoiceNo = tgReceipt.purchase_no ? `TG-${tgReceipt.purchase_no}` : `TG-${String(id).split('-')[0]}`;
      const skippedMaterials: string[] = [];
      let itemIndex = 0;

      for (const item of lineItems) {
        if (!item.item_name) continue;
        const normalizedName = item.item_name.trim().toLowerCase();

        // Exact match first, then partial/contains
        let matchedMaterial = allMaterials.find(m => m.name.toLowerCase() === normalizedName);
        if (!matchedMaterial) {
          matchedMaterial = allMaterials.find(m =>
            normalizedName.includes(m.name.toLowerCase()) ||
            m.name.toLowerCase().includes(normalizedName)
          );
        }

        // If not found in materials catalog, auto-create material with the free-text name
        if (!matchedMaterial) {
          const cleanName = item.item_name.trim().slice(0, 100);
          const { data: newMat, error: newMatErr } = await supabase
            .from("erp_materials")
            .insert({
              name: cleanName,
              category: "Miscellaneous",
              unit: item.unit || "kg",
              buy_price: item.rate || 0,
              sell_price: item.rate || 0,
              stock_qty: 0,
              is_active: true,
            })
            .select("id, name, unit, stock_qty")
            .single();

          if (!newMatErr && newMat) {
            matchedMaterial = newMat;
            allMaterials.push(newMat);
          } else {
            // Fallback: match any misc material or first material, or leave material_id null
            matchedMaterial = allMaterials.find(m => m.name.toLowerCase().includes("misc")) || allMaterials[0];
          }
        }

        itemIndex++;
        const receiptNum = `${invoiceNo}/${itemIndex}`;
        const totalAmt = item.amount || Number((item.qty * item.rate).toFixed(2));

        newReceiptRows.push({
          receipt_number: receiptNum,
          customer_id:    customerId,
          material_id:    matchedMaterial?.id || null,
          weight:         item.qty || 0,
          unit:           matchedMaterial?.unit || item.unit || "kg",
          price_per_unit: item.rate || 0,
          total_amount:   totalAmt,
          payment_method: tgReceipt.payment_mode || "cash",
          notes:          tgReceipt.notes ? `${item.item_name} — ${tgReceipt.notes}` : item.item_name,
          created_by:     adminId,
          created_at:     tgReceipt.purchase_date ? new Date(tgReceipt.purchase_date).toISOString() : new Date().toISOString(),
        });
      }

      if (newReceiptRows.length === 0 && lineItems.length > 0) {
        res.status(400).json({
          success: false,
          message: `Could not process items: [${lineItems.map((i: any) => i.item_name).join(', ')}].`,
        });
        return;
      }

      // 5. Insert into erp_purchase_receipts
      let firstReceiptId: string | null = null;
      if (newReceiptRows.length > 0) {
        const { data: insertedRows, error: insertErr } = await supabase
          .from("erp_purchase_receipts")
          .insert(newReceiptRows)
          .select("id");

        if (insertErr) {
          if (insertErr.code === '23505') {
            res.status(409).json({ success: false, message: "These receipt numbers already exist. The receipt may have been verified already." });
            return;
          }
          throw new Error("Failed to create ERP receipt: " + insertErr.message);
        }

        firstReceiptId = insertedRows?.[0]?.id ?? null;

        // 6. Update material stock + avg cost for each matched material
        for (const row of newReceiptRows) {
          const mat = allMaterials.find(m => m.id === row.material_id);
          if (mat) {
            await supabase
              .from("erp_materials")
              .update({
                stock_qty: Number(mat.stock_qty || 0) + row.weight,
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.material_id);
          }
        }

        // 7. Update customer stats if customer resolved
        if (customerId) {
          const cumulativeTotal = newReceiptRows.reduce((s, r) => s + r.total_amount, 0);
          const receiptDate = tgReceipt.purchase_date || new Date().toISOString();
          const { data: customer } = await supabase
            .from("erp_customers")
            .select("total_visits, total_paid")
            .eq("id", customerId)
            .single();

          if (customer) {
            await supabase
              .from("erp_customers")
              .update({
                total_visits: (customer.total_visits || 0) + 1,
                total_paid: Number(customer.total_paid || 0) + cumulativeTotal,
                last_receipt_date: receiptDate,
                updated_at: new Date().toISOString(),
              })
              .eq("id", customerId);
          }
        }
      }

      // 8. Mark as verified + link to real receipt
      const { error } = await supabase
        .from("telegram_ingested_receipts")
        .update({
          status:              "verified",
          verified_by:         adminId,
          verified_at:         new Date().toISOString(),
          customer_id:         customerId,
          purchase_receipt_id: firstReceiptId,
        })
        .eq("id", id);

      if (error) throw error;

      const skipNote = skippedMaterials.length > 0
        ? ` (${skippedMaterials.length} item(s) skipped — not found in catalog: ${skippedMaterials.join(', ')})`
        : '';

      res.json({
        success: true,
        message: `Receipt approved — ${newReceiptRows.length} item(s) added to ERP as ${invoiceNo}.${skipNote}`,
        receipt_number: invoiceNo,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── PATCH /api/telegram/receipts/:id/reject ──────────────────────────────────
telegramRouter.patch(
  "/receipts/:id/reject",
  requireAdminOrChampion,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const adminId     = req.privilegedUser?.id;
      const { reason }  = req.body as { reason?: string };

      const { error } = await supabase
        .from("telegram_ingested_receipts")
        .update({
          status:        "rejected",
          reject_reason: reason ?? null,
          verified_by:   adminId,
          verified_at:   new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;
      res.json({ success: true, message: "Receipt rejected." });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── GET /api/telegram/receipts/:id/pdf ───────────────────────────────────────
// Returns a signed URL to the original PDF for admin preview
telegramRouter.get(
  "/receipts/:id/pdf",
  requireAdminOrChampion,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { data: receipt, error } = await supabase
        .from("telegram_ingested_receipts")
        .select("id, pdf_storage_path")
        .eq("id", id)
        .single();

      if (error || !receipt) {
        res.status(404).json({ success: false, message: "Receipt not found." });
        return;
      }

      await ensureStorageBucket();

      let targetPath = receipt.pdf_storage_path;

      // If pdf_storage_path was null, check if a file was uploaded at the default path
      if (!targetPath) {
        const candidate = `telegram/${id}.pdf`;
        const { data: files } = await supabase.storage
          .from(STORAGE_BUCKET)
          .list("telegram", { search: `${id}.pdf` });
        if (files && files.length > 0) {
          targetPath = candidate;
          await supabase
            .from("telegram_ingested_receipts")
            .update({ pdf_storage_path: candidate })
            .eq("id", id);
        }
      }

      if (!targetPath) {
        res.status(404).json({ success: false, message: "PDF not found in storage." });
        return;
      }

      const { data: signedData, error: signErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(targetPath, 60 * 60); // 1-hour expiry

      if (signErr || !signedData?.signedUrl) {
        console.error("[Telegram PDF] createSignedUrl error:", signErr);
        res.status(500).json({ success: false, message: "Could not generate PDF URL." });
        return;
      }

      res.json({ success: true, url: signedData.signedUrl });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);
