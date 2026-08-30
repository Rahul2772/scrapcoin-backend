/**
 * Telegram Receipt Ingestion Route
 * POST /api/telegram/webhook        — receives Telegram updates (PDF receipts)
 * GET  /api/telegram/receipts       — list ingested receipts (admin)
 * PATCH /api/telegram/receipts/:id/verify  — admin approves
 * PATCH /api/telegram/receipts/:id/reject  — admin rejects
 */

import { Router, type Request, type Response } from "express";
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
    // Next non-empty line after "Bill From" is likely the name
    const nameLine = lines[billFromIdx + 1];
    if (nameLine && !/mobile|phone|address|₹|\d{10}/i.test(nameLine)) {
      result.customer_name = nameLine;
    }
    // Look for a 10-digit mobile nearby
    for (let i = billFromIdx + 1; i <= Math.min(billFromIdx + 5, lines.length - 1); i++) {
      const mobileMatch = lines[i].match(/(?:\+91[-\s]?)?(\d{10})/);
      if (mobileMatch) {
        result.customer_mobile = mobileMatch[1];
        break;
      }
    }
  }
  // Fallback: scan whole text for mobile
  if (!result.customer_mobile) {
    const mobileMatch = text.match(/(?:\+91[-\s]?)?(\d{10})/);
    if (mobileMatch) result.customer_mobile = mobileMatch[1];
  }

  // ── Address (optional) ────────────────────────────────────────────────────
  const addrMatch = text.match(/Address\s*[:\-]?\s*(.+)/i);
  if (addrMatch) result.customer_address = addrMatch[1].trim();

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
        .select("*, erp_customers(name, phone)")
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

// ── PATCH /api/telegram/receipts/:id/verify ──────────────────────────────────
telegramRouter.patch(
  "/receipts/:id/verify",
  requireAdminOrChampion,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const adminId = req.privilegedUser?.id;

      // 1. Fetch the telegram receipt
      const { data: tgReceipt, error: fetchErr } = await supabase
        .from("telegram_ingested_receipts")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchErr || !tgReceipt) throw new Error("Receipt not found.");
      if (tgReceipt.status === "verified") return; // already verified
      
      const lineItems = tgReceipt.line_items || [];
      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        throw new Error("Cannot verify an unreadable receipt with no items. Please manually create a scale ticket.");
      }

      // 2. Map line items to material IDs
      const { data: allMaterials, error: matErr } = await supabase
        .from("erp_materials")
        .select("id, name");
      
      if (matErr || !allMaterials) throw new Error("Failed to fetch materials catalog.");

      const newReceiptRows = [];
      const invoiceNo = tgReceipt.purchase_no ? `TG-${tgReceipt.purchase_no}` : `TG-${id.split('-')[0]}`;

      for (const item of lineItems) {
        if (!item.item_name) continue;
        const normalizedName = item.item_name.trim().toLowerCase();
        
        const matchedMaterial = allMaterials.find(m => m.name.toLowerCase() === normalizedName);
        if (!matchedMaterial) {
          throw new Error(`Material '${item.item_name}' not found in the ERP catalog. Please add it first.`);
        }

        newReceiptRows.push({
          receipt_number: `${invoiceNo}-${item.sno || Math.floor(Math.random()*1000)}`,
          customer_id:    tgReceipt.customer_id,
          material_id:    matchedMaterial.id,
          weight:         item.qty || 0,
          unit:           "kg",
          price_per_unit: item.rate || 0,
          total_amount:   item.amount || 0,
          payment_method: tgReceipt.payment_mode || "cash",
          notes:          "Auto-generated from Telegram receipt",
          created_by:     adminId,
          created_at:     tgReceipt.purchase_date ? new Date(tgReceipt.purchase_date).toISOString() : new Date().toISOString()
        });
      }

      // 3. Insert into erp_purchase_receipts
      if (newReceiptRows.length > 0) {
        const { error: insertErr } = await supabase
          .from("erp_purchase_receipts")
          .insert(newReceiptRows);
        
        if (insertErr) {
          if (insertErr.code === '23505') {
             // Unique violation on receipt_number, which might happen if already verified manually
             throw new Error("These receipt numbers already exist. It might have been verified already.");
          }
          throw new Error("Failed to create ERP receipt: " + insertErr.message);
        }
      }

      // 4. Mark as verified
      const { error } = await supabase
        .from("telegram_ingested_receipts")
        .update({
          status:      "verified",
          verified_by: adminId,
          verified_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;
      res.json({ success: true, message: "Receipt verified and added to main ERP." });
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
      const { data: receipt, error } = await supabase
        .from("telegram_ingested_receipts")
        .select("pdf_storage_path")
        .eq("id", req.params.id)
        .single();

      if (error || !receipt?.pdf_storage_path) {
        res.status(404).json({ success: false, message: "PDF not found." });
        return;
      }

      const { data: signedData, error: signErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(receipt.pdf_storage_path, 60 * 60); // 1-hour expiry

      if (signErr || !signedData?.signedUrl) {
        res.status(500).json({ success: false, message: "Could not generate PDF URL." });
        return;
      }

      res.json({ success: true, url: signedData.signedUrl });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);
