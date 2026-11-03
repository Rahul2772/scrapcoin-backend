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
import { normalizePhone, parseReceiptText, isHighConfidence } from "../lib/receipt-parser.js";
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
      // Private: receipt PDFs hold customer names, phones and addresses.
      // The API hands out short-lived signed URLs instead.
      const { error: createErr } = await supabase.storage.createBucket(STORAGE_BUCKET, {
        public: false,
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

/** Active customer whose phone matches (compared on the last 10 digits) */
async function findCustomerByPhone(rawPhone: string) {
  const normalizedPhone = normalizePhone(rawPhone);
  if (normalizedPhone.length < 10) return null;

  const { data: allCustomers } = await supabase
    .from("erp_customers")
    .select("id, name, phone, address")
    .eq("is_active", true);

  return (allCustomers ?? []).find(
    (c) => c.phone && normalizePhone(c.phone) === normalizedPhone
  ) ?? null;
}

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

    // Phase 6 — Customer lookup only. New customers are created on approval, after a
    // human has checked the parsed name/mobile/address (see /verify).
    let customerId: string | null = null;
    let customerStatus: "matched" | "new" | "none" = "none";

    if (parsed.customer_mobile) {
      const match = await findCustomerByPhone(parsed.customer_mobile);
      if (match) {
        customerId     = match.id;
        customerStatus = "matched";
      } else if (parsed.customer_name) {
        customerStatus = "new";
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
        : customerStatus === "new"
        ? "(⚠️ NEW customer — created when admin approves)"
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

      // Receipts ingested before unlabelled addresses were supported have no address saved.
      // Re-read it from the stored PDF text so the review popup can pre-fill it (read-only;
      // it is saved when the reviewer saves or approves).
      const receipts = (data ?? []).map((r: any) => {
        if (r.status !== "pending_review" || r.customer_address || !r.raw_extracted_text) return r;
        const reparsed = parseReceiptText(r.raw_extracted_text);
        return { ...r, address_from_pdf: reparsed.customer_address ?? null };
      });

      res.json({ success: true, receipts });
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

      // 3. Resolve customer from the reviewed mobile number (it may have been corrected in
      //    the review popup). New customers are only created here, after review.
      let customerId: string | null = null;
      let existingAddress: string | null = null;

      const match = tgReceipt.customer_mobile ? await findCustomerByPhone(tgReceipt.customer_mobile) : null;
      if (match) {
        customerId = match.id;
        existingAddress = match.address ?? null;
      } else if (!tgReceipt.customer_mobile && tgReceipt.customer_id) {
        // No mobile to match on — keep the customer linked at ingestion
        customerId = tgReceipt.customer_id;
        const { data: linked } = await supabase
          .from("erp_customers")
          .select("address")
          .eq("id", customerId)
          .single();
        existingAddress = linked?.address ?? null;
      } else if (tgReceipt.customer_mobile && tgReceipt.customer_name) {
        const { data: newCust, error: custErr } = await supabase
          .from("erp_customers")
          .insert({
            name:        tgReceipt.customer_name,
            phone:       tgReceipt.customer_mobile,
            address:     tgReceipt.customer_address ?? null,
            created_via: "telegram_auto",
            is_active:   true,
          })
          .select("id, address")
          .single();

        if (!custErr && newCust) {
          customerId = newCust.id;
          existingAddress = newCust.address ?? null;
        }
      }

      // Keep the customer's address in step with the reviewed receipt (latest wins), but
      // never blank out an address the customer already has.
      const reviewedAddress = tgReceipt.customer_address?.trim() || null;
      if (customerId && reviewedAddress && reviewedAddress !== existingAddress) {
        await supabase
          .from("erp_customers")
          .update({ address: reviewedAddress, updated_at: new Date().toISOString() })
          .eq("id", customerId);
      }

      // 4. Map line items to material IDs via fuzzy match
      const { data: allMaterials, error: matErr } = await supabase
        .from("erp_materials")
        .select("*");

      if (matErr || !allMaterials) throw new Error("Failed to fetch materials catalog.");

      // "METAL E WASTE", "Metal E-waste" and "metal e waste" all compare equal.
      // A material also answers to its aliases (names of SKUs merged into it).
      const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const keysOf = (m: any): string[] =>
        [m.name, ...(Array.isArray(m.aliases) ? m.aliases : [])].map(nameKey).filter(Boolean);

      const newReceiptRows: any[] = [];
      const invoiceNo = tgReceipt.purchase_no ? `TG-${tgReceipt.purchase_no}` : `TG-${String(id).split('-')[0]}`;
      const skippedMaterials: string[] = [];
      let itemIndex = 0;

      for (const item of lineItems) {
        if (!item.item_name) continue;
        const normalizedName = nameKey(item.item_name);

        // Exact match (name or alias) first, then partial/contains
        let matchedMaterial = allMaterials.find(m => keysOf(m).includes(normalizedName));
        if (!matchedMaterial && normalizedName) {
          matchedMaterial = allMaterials.find(m =>
            keysOf(m).some(k => normalizedName.includes(k) || k.includes(normalizedName))
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
            .select("*")
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
            // Keep the in-memory value current: a receipt can list the same
            // material twice, and each line must add to the previous total.
            mat.stock_qty = Number(mat.stock_qty || 0) + Number(row.weight || 0);
            await supabase
              .from("erp_materials")
              .update({
                stock_qty: mat.stock_qty,
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
