import { Router } from "express";
import { z } from "zod";
import { requireAdminOrChampion } from "../middleware/requireAdminOrChampion.js";
import { supabase } from "../lib/supabase.js";
import { sendWhatsAppMessage } from "../lib/twilio.js";

export const erpRouter = Router();

// Secure all ERP endpoints under admin / champion check
erpRouter.use(requireAdminOrChampion);

// ── HELPER: Recalculate & persist weighted average buy cost for a material ────
// Called after every purchase receipt INSERT / UPDATE / DELETE to keep
// erp_materials.avg_cost_per_unit always up to date.
async function refreshAvgCostPerUnit(materialId: string): Promise<void> {
  try {
    const { data: receipts } = await supabase
      .from("erp_purchase_receipts")
      .select("weight, total_amount")
      .eq("material_id", materialId);

    const totalWeight = (receipts || []).reduce((s, r) => s + Number(r.weight), 0);
    const totalCost   = (receipts || []).reduce((s, r) => s + Number(r.total_amount), 0);
    const avg = totalWeight > 0 ? Number((totalCost / totalWeight).toFixed(2)) : 0;

    await supabase
      .from("erp_materials")
      .update({ avg_cost_per_unit: avg, updated_at: new Date().toISOString() })
      .eq("id", materialId);
  } catch (err) {
    // Non-fatal — log and continue so receipt operations are never blocked
    console.warn(`[refreshAvgCostPerUnit] Failed for material ${materialId}:`, err);
  }
}

// ── ZOD SCHEMAS ──────────────────────────────────────────────────────────────

const materialSchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(50),
  unit: z.string().trim().default("kg"),
  buy_price: z.number().nonnegative(),
  sell_price: z.number().nonnegative(),
  min_threshold: z.number().nonnegative().optional().default(0),
  color_hex: z.string().trim().regex(/^#[a-fA-F0-9]{6}$/).optional().default("#f5a623"),
  stock_qty: z.number().optional().default(0),
});

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(150),
  phone: z.string().trim().optional().nullable(),
  whatsapp: z.string().trim().optional().nullable(),
  upi: z.string().trim().optional().nullable(),
  email: z.string().trim().email().or(z.literal("")).optional().nullable(),
  address: z.string().trim().optional().nullable(),
  id_type: z.string().trim().optional().nullable(),
  id_number: z.string().trim().optional().nullable(),
});

const customerSchema = z.object({
  name: z.string().trim().min(1).max(255),
  phone: z.string().trim().optional().nullable(),
  whatsapp: z.string().trim().optional().nullable(),
  upi: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  id_type: z.string().trim().optional().nullable(),
  id_number: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  last_receipt_date: z.string().optional().nullable(),
});

const transactionSchema = z.object({
  supplier_id: z.string().uuid(),
  notes: z.string().trim().optional().nullable(),
  due_date: z.string().optional().nullable(),
  payment_method: z.string().optional().nullable(),
  created_at: z.string().trim().optional().nullable(),
  // Single entry fallback
  material_id: z.string().uuid().optional(),
  weight: z.number().positive().optional(),
  price_per_unit: z.number().nonnegative().optional(),
  gst_rate: z.number().min(0).max(100).optional().default(0),
  // Multi entry
  items: z.array(z.object({
    material_id: z.string().uuid(),
    weight: z.number().positive(),
    price_per_unit: z.number().nonnegative(),
    gst_rate: z.number().min(0).max(100).optional().default(0),
  })).optional(),
  // Optional: link to an existing sale batch (for edits)
  sale_batch_id: z.string().uuid().optional().nullable(),
});

const purchaseReceiptSchema = z.object({
  customer_id: z.string().trim().optional().nullable().transform((val) => (val === "" ? null : val)),
  payment_method: z.string().optional().default("cash"),
  notes: z.string().trim().optional().nullable(),
  created_at: z.string().trim().optional().nullable(),
  // Single entry fallback
  material_id: z.string().trim().optional(),
  weight: z.number().positive().optional(),
  price_per_unit: z.number().nonnegative().optional(),
  // Multi entry
  items: z.array(z.object({
    material_id: z.string().trim().min(1),
    weight: z.number().positive(),
    price_per_unit: z.number().nonnegative(),
  })).optional(),
});


const payInvoiceSchema = z.object({
  payment_method: z.enum(["cash", "upi", "bank_transfer", "cheque"]),
  notes: z.string().trim().optional().nullable(),
});

// ── 1. MATERIALS ──────────────────────────────────────────────────────────────

// GET /api/erp/materials — List active materials
erpRouter.get("/materials", async (req, res) => {
  try {
    const { category } = req.query;
    let queryBuilder = supabase.from("erp_materials").select("*").eq("is_active", true);

    if (category) {
      queryBuilder = queryBuilder.eq("category", String(category));
    }

    const { data, error } = await queryBuilder.order("category").order("name");
    if (error) throw error;

    const enriched = (data || []).map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      unit: m.unit,
      buy_price: Number(m.buy_price),
      sell_price: Number(m.sell_price),
      stock_qty: Number(m.stock_qty),
      min_threshold: Number(m.min_threshold),
      avg_cost_per_unit: Number(m.avg_cost_per_unit ?? 0),
      color_hex: m.color_hex,
      is_active: m.is_active,
      updated_at: m.updated_at,
      is_low_stock: Number(m.stock_qty) <= Number(m.min_threshold),
    }));

    res.json({ success: true, count: enriched.length, materials: enriched });
  } catch (err: any) {
    console.error("GET /api/erp/materials error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/erp/materials/:id/price-history — Price revision logs
erpRouter.get("/materials/:id/price-history", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("erp_price_history")
      .select("*, changed_by_profile:changed_by(email)")
      .eq("material_id", req.params.id)
      .order("changed_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    const formatted = (data || []).map((ph) => ({
      id: ph.id,
      material_id: ph.material_id,
      old_buy_price: Number(ph.old_buy_price),
      new_buy_price: Number(ph.new_buy_price),
      old_sell_price: Number(ph.old_sell_price),
      new_sell_price: Number(ph.new_sell_price),
      changed_at: ph.changed_at,
      changed_by_name: ph.changed_by_profile?.email || "System",
    }));

    res.json({ success: true, history: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/erp/materials — Create a material
erpRouter.post("/materials", async (req, res) => {
  const parsed = materialSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const { data, error } = await supabase
      .from("erp_materials")
      .insert({
        name: parsed.data.name,
        category: parsed.data.category,
        unit: parsed.data.unit,
        buy_price: parsed.data.buy_price,
        sell_price: parsed.data.sell_price,
        stock_qty: parsed.data.stock_qty,
        min_threshold: parsed.data.min_threshold,
        color_hex: parsed.data.color_hex,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, message: "Material created.", material: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/erp/materials/:id — Update a material (log price changes)
erpRouter.put("/materials/:id", async (req, res) => {
  const parsed = materialSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const { data: existing, error: getError } = await supabase
      .from("erp_materials")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (getError || !existing) {
      return res.status(404).json({ success: false, message: "Material not found." });
    }

    const buyPrice = parsed.data.buy_price !== undefined ? parsed.data.buy_price : Number(existing.buy_price);
    const sellPrice = parsed.data.sell_price !== undefined ? parsed.data.sell_price : Number(existing.sell_price);

    // Record price history if prices changed
    if (buyPrice !== Number(existing.buy_price) || sellPrice !== Number(existing.sell_price)) {
      await supabase.from("erp_price_history").insert({
        material_id: req.params.id,
        old_buy_price: existing.buy_price,
        new_buy_price: buyPrice,
        old_sell_price: existing.sell_price,
        new_sell_price: sellPrice,
        changed_by: req.privilegedUser?.id,
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from("erp_materials")
      .update({
        name: parsed.data.name,
        category: parsed.data.category,
        unit: parsed.data.unit,
        buy_price: buyPrice,
        sell_price: sellPrice,
        stock_qty: parsed.data.stock_qty !== undefined ? parsed.data.stock_qty : existing.stock_qty,
        min_threshold: parsed.data.min_threshold !== undefined ? parsed.data.min_threshold : existing.min_threshold,
        color_hex: parsed.data.color_hex || existing.color_hex,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json({ success: true, message: "Material updated.", material: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/erp/materials/:id — Soft deactivate material (Admin only)
erpRouter.delete("/materials/:id", async (req, res) => {
  if (req.privilegedUser?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  try {
    const { error } = await supabase
      .from("erp_materials")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    if (error) throw error;
    res.json({ success: true, message: "Material deactivated." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/erp/materials/recalculate-stock — Recalculate all material stock from transaction history
erpRouter.post("/materials/recalculate-stock", async (req, res) => {
  if (req.privilegedUser?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  try {
    // Fetch all active materials
    const { data: materials, error: matErr } = await supabase
      .from("erp_materials")
      .select("id, name, stock_qty")
      .eq("is_active", true);

    if (matErr) throw matErr;

    // Fetch all purchase receipts (buy from customers → adds stock)
    const { data: receipts, error: rErr } = await supabase
      .from("erp_purchase_receipts")
      .select("material_id, weight");
    if (rErr) throw rErr;

    // Fetch all B2B transactions (sell to recyclers → removes stock)
    const { data: transactions, error: tErr } = await supabase
      .from("erp_transactions")
      .select("material_id, weight");
    if (tErr) throw tErr;

    // Aggregate bought weight per material
    const boughtMap: Record<string, number> = {};
    (receipts || []).forEach((r) => {
      boughtMap[r.material_id] = (boughtMap[r.material_id] || 0) + Number(r.weight);
    });

    // Aggregate sold weight per material
    const soldMap: Record<string, number> = {};
    (transactions || []).forEach((t) => {
      soldMap[t.material_id] = (soldMap[t.material_id] || 0) + Number(t.weight);
    });

    const results: { id: string; name: string; old_stock: number; new_stock: number }[] = [];

    // Update each material stock
    for (const mat of materials || []) {
      const bought = boughtMap[mat.id] || 0;
      const sold = soldMap[mat.id] || 0;
      const correct_stock = Math.max(0, bought - sold);

      await supabase
        .from("erp_materials")
        .update({ stock_qty: correct_stock, updated_at: new Date().toISOString() })
        .eq("id", mat.id);

      results.push({
        id: mat.id,
        name: mat.name,
        old_stock: Number(mat.stock_qty),
        new_stock: correct_stock,
      });
    }

    res.json({ success: true, message: `Recalculated stock for ${results.length} materials.`, results });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});



// GET /api/erp/suppliers — List suppliers
erpRouter.get("/suppliers", async (req, res) => {
  try {
    const { search } = req.query;
    let queryBuilder = supabase.from("erp_suppliers").select("*").eq("is_active", true);

    if (search) {
      queryBuilder = queryBuilder.or(`name.ilike.%${search}%,phone.ilike.%${search}%,whatsapp.ilike.%${search}%,upi.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data: suppliers, error } = await queryBuilder.order("name");
    if (error) throw error;

    // Fetch counts and aggregates (simulated by fetching counts, or we do client-side/in-subqueries)
    // To keep it performant and simple, we'll fetch data and enrich supplier totals.
    const enriched = await Promise.all(
      (suppliers || []).map(async (s) => {
        const { count, error: countErr } = await supabase
          .from("erp_transactions")
          .select("*", { count: "exact", head: true })
          .eq("supplier_id", s.id);

        const { data: txns } = await supabase
          .from("erp_transactions")
          .select("total_amount")
          .eq("supplier_id", s.id);

        const totalValue = (txns || []).reduce((sum, t) => sum + Number(t.total_amount), 0);

        return {
          ...s,
          total_transactions: countErr ? 0 : count || 0,
          total_value: totalValue,
        };
      })
    );

    res.json({ success: true, count: enriched.length, suppliers: enriched });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/erp/suppliers/:id — Single supplier details + recent transactions
erpRouter.get("/suppliers/:id", async (req, res) => {
  try {
    const { data: supplier, error: getErr } = await supabase
      .from("erp_suppliers")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (getErr || !supplier) {
      return res.status(404).json({ success: false, message: "Supplier not found." });
    }

    const { data: txns, error: txnsErr } = await supabase
      .from("erp_transactions")
      .select("*, erp_materials(name)")
      .eq("supplier_id", req.params.id)
      .order("created_at", { ascending: false })
      .limit(20);

    const mappedTxns = (txns || []).map((t) => ({
      ...t,
      material_name: t.erp_materials?.name || "Scrap Material",
    }));

    res.json({
      success: true,
      supplier,
      recent_transactions: mappedTxns,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/erp/suppliers — Create a supplier
erpRouter.post("/suppliers", async (req, res) => {
  const parsed = supplierSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const { data, error } = await supabase
      .from("erp_suppliers")
      .insert({
        name: parsed.data.name,
        phone: parsed.data.phone || null,
        whatsapp: parsed.data.whatsapp || null,
        upi: parsed.data.upi || null,
        email: parsed.data.email || null,
        address: parsed.data.address || null,
        id_type: parsed.data.id_type || null,
        id_number: parsed.data.id_number || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, message: "Supplier created.", supplier: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/erp/suppliers/:id — Update supplier
erpRouter.put("/suppliers/:id", async (req, res) => {
  const parsed = supplierSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const { data, error } = await supabase
      .from("erp_suppliers")
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, message: "Supplier updated.", supplier: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/erp/suppliers/:id — Soft deactivate supplier (Admin only)
erpRouter.delete("/suppliers/:id", async (req, res) => {
  if (req.privilegedUser?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  try {
    const { error } = await supabase
      .from("erp_suppliers")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    if (error) throw error;
    res.json({ success: true, message: "Supplier deactivated." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 3. CUSTOMERS (B2C) ─────────────────────────────────────────────────────────

// Helper to check customers whose last receipt is 30+ days ago and generate admin notifications
export async function checkAndGenerate30DayNotifications() {
  try {
    const { data: customers, error } = await supabase
      .from("erp_customers")
      .select("*")
      .eq("is_active", true);

    if (error || !customers) return;

    const now = new Date();

    for (const c of customers) {
      let lastReceiptDateStr = c.last_receipt_date || null;

      // Fallback: check latest purchase receipt if not set on customer
      if (!lastReceiptDateStr) {
        const { data: latestReceipt } = await supabase
          .from("erp_purchase_receipts")
          .select("created_at")
          .eq("customer_id", c.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestReceipt?.created_at) {
          lastReceiptDateStr = latestReceipt.created_at;
          await supabase
            .from("erp_customers")
            .update({ last_receipt_date: latestReceipt.created_at })
            .eq("id", c.id);
        }
      }

      if (!lastReceiptDateStr) continue;

      const lastDate = new Date(lastReceiptDateStr);
      const diffMs = now.getTime() - lastDate.getTime();
      const daysSince = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (daysSince >= 30) {
        // Prevent duplicate notifications in last 30 days
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { data: existing } = await supabase
          .from("erp_notifications")
          .select("id")
          .eq("customer_id", c.id)
          .eq("type", "customer_30_days")
          .gte("created_at", thirtyDaysAgo)
          .limit(1);

        if (!existing || existing.length === 0) {
          const formattedDate = lastDate.toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          });
          await supabase.from("erp_notifications").insert({
            title: `30-Day Pickup Trigger: ${c.name}`,
            message: `Customer ${c.name} (${c.phone || "No phone"}) had their last scale receipt on ${formattedDate} (${daysSince} days ago). Trigger follow-up pickup request.`,
            type: "customer_30_days",
            customer_id: c.id,
            is_read: false,
            created_at: new Date().toISOString(),
          });
        }
      }
    }
  } catch (err) {
    console.error("[30-Day Notification Check Error]", err);
  }
}

// GET /api/erp/customers — List customers
erpRouter.get("/customers", async (req, res) => {
  try {
    const { search, limit = 200 } = req.query;
    let queryBuilder = supabase.from("erp_customers").select("*").eq("is_active", true);

    if (search) {
      queryBuilder = queryBuilder.or(`name.ilike.%${search}%,phone.ilike.%${search}%,whatsapp.ilike.%${search}%,upi.ilike.%${search}%`);
    }

    const { data: customers, error } = await queryBuilder
      .order("name", { ascending: true })
      .limit(Number(limit));

    if (error) throw error;

    // Trigger check for 30-day customer notifications
    checkAndGenerate30DayNotifications().catch(() => {});

    const enriched = await Promise.all(
      (customers || []).map(async (c) => {
        const { count, error: countErr } = await supabase
          .from("erp_purchase_receipts")
          .select("*", { count: "exact", head: true })
          .eq("customer_id", c.id);

        const { data: receipts } = await supabase
          .from("erp_purchase_receipts")
          .select("total_amount, created_at")
          .eq("customer_id", c.id)
          .order("created_at", { ascending: false });

        const totalPaid = (receipts || []).reduce((sum, r) => sum + Number(r.total_amount), 0);

        let lastReceiptDateStr = c.last_receipt_date || null;
        if (!lastReceiptDateStr && receipts && receipts.length > 0) {
          lastReceiptDateStr = receipts[0].created_at;
        }

        let daysSinceLastReceipt: number | null = null;
        let is30DayAlert = false;

        if (lastReceiptDateStr) {
          const lastDate = new Date(lastReceiptDateStr);
          const diffMs = new Date().getTime() - lastDate.getTime();
          daysSinceLastReceipt = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          if (daysSinceLastReceipt >= 30) {
            is30DayAlert = true;
          }
        }

        return {
          ...c,
          last_receipt_date: lastReceiptDateStr,
          days_since_last_receipt: daysSinceLastReceipt,
          is_30_day_alert: is30DayAlert,
          visit_count: countErr ? 0 : count || 0,
          lifetime_paid: totalPaid,
        };
      })
    );

    res.json({ success: true, customers: enriched });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/erp/customers/:id — Customer detail & receipt logs
erpRouter.get("/customers/:id", async (req, res) => {
  try {
    const { data: customer, error: getErr } = await supabase
      .from("erp_customers")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (getErr || !customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    const { data: receipts, error: receiptsErr } = await supabase
      .from("erp_purchase_receipts")
      .select("*, erp_materials(name)")
      .eq("customer_id", req.params.id)
      .order("created_at", { ascending: false })
      .limit(50);

    let lastReceiptDateStr = customer.last_receipt_date || null;
    if (!lastReceiptDateStr && receipts && receipts.length > 0) {
      lastReceiptDateStr = receipts[0].created_at;
    }

    let daysSinceLastReceipt: number | null = null;
    let is30DayAlert = false;

    if (lastReceiptDateStr) {
      const lastDate = new Date(lastReceiptDateStr);
      const diffMs = new Date().getTime() - lastDate.getTime();
      daysSinceLastReceipt = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (daysSinceLastReceipt >= 30) {
        is30DayAlert = true;
      }
    }

    const formattedReceipts = (receipts || []).map((r) => ({
      ...r,
      material_name: r.erp_materials?.name || "Scrap Material",
    }));

    res.json({
      success: true,
      customer: {
        ...customer,
        last_receipt_date: lastReceiptDateStr,
        days_since_last_receipt: daysSinceLastReceipt,
        is_30_day_alert: is30DayAlert,
      },
      receipts: formattedReceipts,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/erp/customers — Add customer
erpRouter.post("/customers", async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const insertPayload: Record<string, unknown> = {
      name: parsed.data.name,
      phone: parsed.data.phone || null,
      whatsapp: parsed.data.whatsapp || null,
      upi: parsed.data.upi || null,
      address: parsed.data.address || null,
      id_type: parsed.data.id_type || "Aadhaar",
      id_number: parsed.data.id_number || null,
      notes: parsed.data.notes || null,
    };

    if (parsed.data.last_receipt_date) {
      insertPayload.last_receipt_date = parsed.data.last_receipt_date;
    }

    const { data, error } = await supabase
      .from("erp_customers")
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      if (error.code === "PGRST204" && String(error.message).includes("last_receipt_date")) {
        delete insertPayload.last_receipt_date;
        const { data: data2, error: error2 } = await supabase
          .from("erp_customers")
          .insert(insertPayload)
          .select()
          .single();
        if (error2) throw error2;
        return res.status(201).json({ success: true, customer: data2 });
      }
      throw error;
    }
    res.status(201).json({ success: true, customer: data });
  } catch (err: any) {
    console.error("POST /api/erp/customers error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// PUT /api/erp/customers/:id — Edit customer
erpRouter.put("/customers/:id", async (req, res) => {
  const parsed = customerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    console.error("[PUT /customers/:id] Validation error:", parsed.error.flatten());
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    // Build the update payload with only columns that definitely exist in the schema.
    // last_receipt_date is a newer migration column — include it only when provided,
    // wrapped in a try so a missing column doesn't block the whole save.
    const baseUpdate: Record<string, unknown> = {
      name:        parsed.data.name,
      phone:       parsed.data.phone ?? null,
      whatsapp:    parsed.data.whatsapp ?? null,
      upi:         parsed.data.upi ?? null,
      address:     parsed.data.address ?? null,
      id_type:     parsed.data.id_type ?? null,
      id_number:   parsed.data.id_number ?? null,
      notes:       parsed.data.notes ?? null,
      updated_at:  new Date().toISOString(),
    };

    // Remove undefined keys so Supabase doesn't try to set them
    Object.keys(baseUpdate).forEach((k) => {
      if (baseUpdate[k] === undefined) delete baseUpdate[k];
    });

    // Attempt to include last_receipt_date if provided
    if (parsed.data.last_receipt_date !== undefined) {
      baseUpdate.last_receipt_date = parsed.data.last_receipt_date || null;
    }

    const { data, error } = await supabase
      .from("erp_customers")
      .update(baseUpdate)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) {
      // If last_receipt_date column doesn't exist yet (migration not run), retry without it
      if (error.code === "PGRST204" && String(error.message).includes("last_receipt_date")) {
        delete baseUpdate.last_receipt_date;
        const { data: data2, error: error2 } = await supabase
          .from("erp_customers")
          .update(baseUpdate)
          .eq("id", req.params.id)
          .select()
          .single();
        if (error2) {
          console.error("[PUT /customers/:id] Supabase error (retry):", error2);
          throw error2;
        }
        if (!data2) {
          return res.status(404).json({ success: false, message: "Customer not found or could not be updated." });
        }
        return res.json({ success: true, customer: data2 });
      }
      console.error("[PUT /customers/:id] Supabase error:", error);
      throw error;
    }

    if (!data) {
      console.error("[PUT /customers/:id] No data returned for id:", req.params.id);
      return res.status(404).json({ success: false, message: "Customer not found or could not be updated." });
    }

    res.json({ success: true, customer: data });
  } catch (err: any) {
    console.error("[PUT /customers/:id] Unexpected error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/erp/customers/:id/trigger-30-day-notification — Manually generate 30-day admin alert for customer
erpRouter.post("/customers/:id/trigger-30-day-notification", async (req, res) => {
  try {
    const { data: customer, error: getErr } = await supabase
      .from("erp_customers")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (getErr || !customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    let lastReceiptDateStr = customer.last_receipt_date;
    if (!lastReceiptDateStr) {
      const { data: latestReceipt } = await supabase
        .from("erp_purchase_receipts")
        .select("created_at")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestReceipt?.created_at) {
        lastReceiptDateStr = latestReceipt.created_at;
      }
    }

    const lastDate = lastReceiptDateStr ? new Date(lastReceiptDateStr) : new Date();
    const daysSince = Math.floor((new Date().getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    const formattedDate = lastDate.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });

    const { data: notification, error: insertErr } = await supabase
      .from("erp_notifications")
      .insert({
        title: `30-Day Pickup Trigger: ${customer.name}`,
        message: `Customer ${customer.name} (${customer.phone || "No phone"}) had their last scale receipt on ${formattedDate} (${daysSince} days ago). Trigger follow-up pickup request.`,
        type: "customer_30_days",
        customer_id: customer.id,
        is_read: false,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    res.json({
      success: true,
      message: `30-day notification generated for admin regarding ${customer.name}`,
      notification,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/erp/customers/:id — Deactivate customer (Admin only)
erpRouter.delete("/customers/:id", async (req, res) => {
  if (req.privilegedUser?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  try {
    const { error } = await supabase
      .from("erp_customers")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    if (error) throw error;
    res.json({ success: true, message: "Customer deactivated" });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ── 4. TRANSACTIONS (B2B) ──────────────────────────────────────────────────────

// GET /api/erp/transactions — List transactions
erpRouter.get("/transactions", async (req, res) => {
  try {
    const { supplier_id, material_id, from_date, to_date, page = 1, limit = 20 } = req.query;

    let queryBuilder = supabase
      .from("erp_transactions")
      .select(`
        *,
        erp_suppliers(name, phone),
        erp_materials(name, unit, color_hex),
        erp_invoices(invoice_number, status)
      `);

    if (supplier_id) queryBuilder = queryBuilder.eq("supplier_id", String(supplier_id));
    if (material_id) queryBuilder = queryBuilder.eq("material_id", String(material_id));
    if (from_date) queryBuilder = queryBuilder.gte("created_at", String(from_date));
    if (to_date) queryBuilder = queryBuilder.lte("created_at", `${to_date}T23:59:59.999Z`);

    const offset = (Number(page) - 1) * Number(limit);
    const { data, error } = await queryBuilder
      .order("created_at", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) throw error;

    const formatted = (data || []).map((t: any) => {
      // Flatten the joins to match the old shape expected by the frontend normalizer
      const invoices = Array.isArray(t.erp_invoices) ? t.erp_invoices[0] : t.erp_invoices;
      return {
        id: t.id,
        txn_number: t.txn_number,
        supplier_id: t.supplier_id,
        material_id: t.material_id,
        weight: Number(t.weight),
        unit: t.unit,
        price_per_unit: Number(t.price_per_unit),
        subtotal: Number(t.subtotal),
        gst_rate: Number(t.gst_rate),
        gst_amount: Number(t.gst_amount),
        total_amount: Number(t.total_amount),
        notes: t.notes,
        created_by: t.created_by,
        created_at: t.created_at,
        supplier_name: t.erp_suppliers?.name || "",
        supplier_phone: t.erp_suppliers?.phone || "",
        material_name: t.erp_materials?.name || "",
        material_unit: t.erp_materials?.unit || "kg",
        color_hex: t.erp_materials?.color_hex || "#f5a623",
        invoice_number: invoices?.invoice_number || "",
        invoice_status: invoices?.status || "pending",
        invoice_id: invoices?.id || null,
      };
    });

    res.json({ success: true, count: formatted.length, page: Number(page), transactions: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/erp/transactions/:id — Single transaction details
erpRouter.get("/transactions/:id", async (req, res) => {
  try {
    const { data: t, error } = await supabase
      .from("erp_transactions")
      .select(`
        *,
        erp_suppliers(*),
        erp_materials(*),
        erp_invoices(*)
      `)
      .eq("id", req.params.id)
      .single();

    if (error || !t) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    const invoice = Array.isArray(t.erp_invoices) ? t.erp_invoices[0] : t.erp_invoices;

    const formatted = {
      id: t.id,
      txn_number: t.txn_number,
      supplier_id: t.supplier_id,
      material_id: t.material_id,
      weight: Number(t.weight),
      unit: t.unit,
      price_per_unit: Number(t.price_per_unit),
      subtotal: Number(t.subtotal),
      gst_rate: Number(t.gst_rate),
      gst_amount: Number(t.gst_amount),
      total_amount: Number(t.total_amount),
      notes: t.notes,
      created_by: t.created_by,
      created_at: t.created_at,
      supplier_name: t.erp_suppliers?.name || "",
      supplier_phone: t.erp_suppliers?.phone || "",
      supplier_email: t.erp_suppliers?.email || "",
      id_type: t.erp_suppliers?.id_type || "",
      id_number: t.erp_suppliers?.id_number || "",
      material_name: t.erp_materials?.name || "",
      category: t.erp_materials?.category || "",
      color_hex: t.erp_materials?.color_hex || "#f5a623",
      invoice_id: invoice?.id || null,
      invoice_number: invoice?.invoice_number || "",
      invoice_status: invoice?.status || "pending",
      due_date: invoice?.due_date || "",
      paid_at: invoice?.paid_at || null,
      payment_method: invoice?.payment_method || "",
    };

    res.json({ success: true, transaction: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/erp/transactions — Create scale transaction, auto-invoice & update stock
erpRouter.post("/transactions", async (req, res) => {
  const parsed = transactionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  const { supplier_id, notes, due_date, payment_method, items, created_at } = parsed.data;

  try {
    let itemsToInsert: Array<{ material_id: string; weight: number; price_per_unit: number; gst_rate: number }> = [];

    if (items && items.length > 0) {
      itemsToInsert = items;
    } else {
      if (!parsed.data.material_id || !parsed.data.weight || parsed.data.price_per_unit === undefined) {
        return res.status(422).json({ success: false, message: "Either items or material_id, weight and price_per_unit are required." });
      }
      itemsToInsert = [{
        material_id: parsed.data.material_id,
        weight: parsed.data.weight,
        price_per_unit: parsed.data.price_per_unit,
        gst_rate: parsed.data.gst_rate ?? 0
      }];
    }

    // 1. Verify supplier exists
    const { data: supplier, error: sErr } = await supabase.from("erp_suppliers").select("id, name").eq("id", supplier_id).eq("is_active", true).single();
    if (sErr || !supplier) return res.status(404).json({ success: false, message: "Supplier not found or inactive." });

    // 2. Generate sequential base txn_number
    const { count: txnCount, error: countErr } = await supabase.from("erp_transactions").select("*", { count: "exact", head: true });
    if (countErr) throw countErr;
    const baseTxnNum = `TXN-${String((txnCount || 0) + 1).padStart(5, "0")}`;

    // 3. Generate sequential base invoice_number
    const { count: invCount, error: invCountErr } = await supabase.from("erp_invoices").select("*", { count: "exact", head: true });
    if (invCountErr) throw invCountErr;
    const baseInvNum = `INV-${String((invCount || 0) + 1).padStart(5, "0")}`;

    let firstTxn: any = null;
    let firstInvoice: any = null;

    // 4a. If multiple materials — create one sale batch to group them
    let saleBatchId: string | null = null;
    if (itemsToInsert.length > 1) {
      const batchTotal = itemsToInsert.reduce((sum, item) => {
        const subtotal = item.weight * item.price_per_unit;
        const gst = (subtotal * (item.gst_rate ?? 0)) / 100;
        return sum + subtotal + gst;
      }, 0);

      const { count: batchCount } = await supabase
        .from("erp_sale_batches")
        .select("*", { count: "exact", head: true });
      const batchNumber = `BATCH-${String((batchCount || 0) + 1).padStart(5, "0")}`;

      const { data: batch, error: batchErr } = await supabase
        .from("erp_sale_batches")
        .insert({
          batch_number: batchNumber,
          supplier_id,
          total_amount: Number(batchTotal.toFixed(2)),
          payment_status: payment_method ? "paid" : "pending",
          payment_method: payment_method || null,
          due_date: due_date || null,
          paid_at: payment_method ? (created_at || new Date().toISOString()) : null,
          notes: notes || null,
          created_by: req.privilegedUser?.id || null,
          ...(created_at ? { created_at } : {}),
        })
        .select()
        .single();

      if (batchErr) throw batchErr;
      saleBatchId = batch.id;
    }

    // 4b. Loop insert B2B items
    for (let i = 0; i < itemsToInsert.length; i++) {
      const item = itemsToInsert[i];

      // Verify material exists
      const { data: material, error: mErr } = await supabase.from("erp_materials").select("id, name, unit, stock_qty").eq("id", item.material_id).eq("is_active", true).single();
      if (mErr || !material) return res.status(404).json({ success: false, message: `Material not found or inactive: ${item.material_id}` });

      const subtotal = Number((item.weight * item.price_per_unit).toFixed(2));
      const gst_amount = Number(((subtotal * item.gst_rate) / 100).toFixed(2));
      const total_amount = Number((subtotal + gst_amount).toFixed(2));

      const txn_number = itemsToInsert.length > 1 ? `${baseTxnNum}/${i + 1}` : baseTxnNum;

      // Create transaction
      const txnPayload: any = {
        txn_number,
        supplier_id,
        material_id: item.material_id,
        weight: item.weight,
        unit: material.unit,
        price_per_unit: item.price_per_unit,
        subtotal,
        gst_rate: item.gst_rate,
        gst_amount,
        total_amount,
        notes,
        created_by: req.privilegedUser?.id,
        // Link to batch if multi-material sale
        ...(saleBatchId ? { sale_batch_id: saleBatchId } : {}),
      };
      if (created_at) {
        txnPayload.created_at = created_at;
      }

      const { data: txn, error: insertErr } = await supabase
        .from("erp_transactions")
        .insert(txnPayload)
        .select()
        .single();

      if (insertErr) throw insertErr;

      // Deduct from material stock — selling to recycler reduces inventory
      await supabase
        .from("erp_materials")
        .update({
          stock_qty: Math.max(0, Number(material.stock_qty) - item.weight),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.material_id);

      const invoice_number = itemsToInsert.length > 1 ? `${baseInvNum}/${i + 1}` : baseInvNum;

      // Auto-create invoice
      const invPayload: any = {
        invoice_number,
        transaction_id: txn.id,
        supplier_id,
        amount: total_amount,
        due_date: due_date || null,
        payment_method: payment_method || null,
        status: payment_method ? "paid" : "pending",
        paid_at: payment_method ? (created_at || new Date().toISOString()) : null,
      };
      if (created_at) {
        invPayload.created_at = created_at;
      }

      const { data: invoice, error: invoiceErr } = await supabase
        .from("erp_invoices")
        .insert(invPayload)
        .select()
        .single();

      if (invoiceErr) throw invoiceErr;

      if (i === 0) {
        firstTxn = {
          ...txn,
          material_name: material.name,
          supplier_name: supplier.name,
        };
        firstInvoice = invoice;
      }
    }

    res.status(201).json({
      success: true,
      message: itemsToInsert.length > 1
        ? `Bulk sale batch ${saleBatchId ? "(BATCH created)" : ""} with ${itemsToInsert.length} materials recorded.`
        : "Scale transaction recorded and invoice created.",
      transaction: firstTxn,
      invoice: firstInvoice,
      sale_batch_id: saleBatchId,
    });
  } catch (err: any) {
    console.error("POST /api/erp/transactions error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/erp/sale-batches — List all multi-material bulk sale batches
erpRouter.get("/sale-batches", async (req, res) => {
  try {
    const { data: batches, error } = await supabase
      .from("erp_sale_batches")
      .select(`
        *,
        erp_suppliers(name, phone),
        erp_transactions(id, txn_number, material_id, weight, unit, price_per_unit, total_amount,
          erp_materials(name, category))
      `)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    const formatted = (batches || []).map((b: any) => ({
      id: b.id,
      batch_number: b.batch_number,
      supplier_id: b.supplier_id,
      supplier_name: b.erp_suppliers?.name || "Unknown",
      total_amount: Number(b.total_amount),
      payment_status: b.payment_status,
      payment_method: b.payment_method,
      due_date: b.due_date,
      paid_at: b.paid_at,
      notes: b.notes,
      created_at: b.created_at,
      lines: (b.erp_transactions || []).map((t: any) => ({
        txn_number: t.txn_number,
        material_id: t.material_id,
        material_name: t.erp_materials?.name || "",
        material_category: t.erp_materials?.category || "",
        weight: Number(t.weight),
        unit: t.unit,
        price_per_unit: Number(t.price_per_unit),
        total_amount: Number(t.total_amount),
      })),
    }));

    res.json({ success: true, count: formatted.length, batches: formatted });
  } catch (err: any) {
    console.error("GET /api/erp/sale-batches error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});


erpRouter.put("/transactions/:id", async (req, res) => {
  const parsed = transactionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  const txnId = req.params.id;
  const { supplier_id, notes, due_date, payment_method, items, created_at } = parsed.data;

  try {
    // 1. Fetch old transaction
    const { data: oldTxn, error: fetchErr } = await supabase
      .from("erp_transactions")
      .select("*")
      .eq("id", txnId)
      .single();

    if (fetchErr || !oldTxn) {
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }

    const baseTxnNum = oldTxn.txn_number.split("/")[0];

    // Find all siblings
    const { data: siblings, error: sibErr } = await supabase
      .from("erp_transactions")
      .select("*")
      .or(`txn_number.eq.${baseTxnNum},txn_number.like.${baseTxnNum}/%`);

    if (sibErr) throw sibErr;

    // 2. Normalize and validate new items FIRST before modifying DB
    let itemsToInsert: Array<{ material_id: string; weight: number; price_per_unit: number; gst_rate: number }> = [];

    if (items && items.length > 0) {
      itemsToInsert = items;
    } else {
      if (!parsed.data.material_id || !parsed.data.weight || parsed.data.price_per_unit === undefined) {
        return res.status(422).json({ success: false, message: "Either items or material_id, weight and price_per_unit are required." });
      }
      itemsToInsert = [{
        material_id: parsed.data.material_id,
        weight: parsed.data.weight,
        price_per_unit: parsed.data.price_per_unit,
        gst_rate: parsed.data.gst_rate ?? 0
      }];
    }

    // Verify supplier exists
    const { data: supplier, error: sErr } = await supabase.from("erp_suppliers").select("id, name").eq("id", supplier_id).eq("is_active", true).single();
    if (sErr || !supplier) return res.status(404).json({ success: false, message: "Recycler not found or inactive." });

    // Verify all new materials exist
    const validatedMaterials: Record<string, any> = {};
    for (const item of itemsToInsert) {
      const { data: mat, error: mErr } = await supabase
        .from("erp_materials")
        .select("id, name, unit, stock_qty")
        .eq("id", item.material_id)
        .eq("is_active", true)
        .single();
      if (mErr || !mat) return res.status(404).json({ success: false, message: `Material not found or inactive: ${item.material_id}` });
      validatedMaterials[item.material_id] = mat;
    }

    // Preserve creation date unless explicitly provided with a valid date string
    let targetCreatedAt = oldTxn.created_at;
    if (created_at) {
      const pDate = new Date(created_at);
      if (!isNaN(pDate.getTime())) {
        targetCreatedAt = pDate.toISOString();
      }
    }

    // 3. Revert stock, delete old invoices and transaction rows
    const oldSiblings = siblings || [];
    for (const sib of oldSiblings) {
      // Revert stock — restore material that was sold (undo deduction)
      const { data: material } = await supabase
        .from("erp_materials")
        .select("stock_qty")
        .eq("id", sib.material_id)
        .single();
      if (material) {
        await supabase
          .from("erp_materials")
          .update({
            stock_qty: Number(material.stock_qty) + Number(sib.weight),
            updated_at: new Date().toISOString(),
          })
          .eq("id", sib.material_id);
      }

      await supabase.from("erp_invoices").delete().eq("transaction_id", sib.id);
      await supabase.from("erp_transactions").delete().eq("id", sib.id);
    }

    // 4. Generate base invoice_number prefix
    const { count: invCount } = await supabase.from("erp_invoices").select("*", { count: "exact", head: true });
    const baseInvNum = `INV-${String((invCount || 0) + 1).padStart(5, "0")}`;

    let firstTxn: any = null;
    let firstInvoice: any = null;

    // 5. Loop insert B2B items under baseTxnNum
    for (let i = 0; i < itemsToInsert.length; i++) {
      const item = itemsToInsert[i];
      const material = validatedMaterials[item.material_id];

      const subtotal = Number((item.weight * item.price_per_unit).toFixed(2));
      const gst_amount = Number(((subtotal * item.gst_rate) / 100).toFixed(2));
      const total_amount = Number((subtotal + gst_amount).toFixed(2));

      const txn_number = itemsToInsert.length > 1 ? `${baseTxnNum}/${i + 1}` : baseTxnNum;

      const txnPayload: any = {
        txn_number,
        supplier_id,
        material_id: item.material_id,
        weight: item.weight,
        unit: material.unit,
        price_per_unit: item.price_per_unit,
        subtotal,
        gst_rate: item.gst_rate,
        gst_amount,
        total_amount,
        notes,
        created_by: req.privilegedUser?.id,
        created_at: targetCreatedAt,
        updated_at: new Date().toISOString(),
      };

      const { data: txn, error: insertErr } = await supabase
        .from("erp_transactions")
        .insert(txnPayload)
        .select()
        .single();

      if (insertErr) throw insertErr;

      // Fetch fresh material stock to deduct sold quantity
      const { data: freshMat } = await supabase
        .from("erp_materials")
        .select("stock_qty")
        .eq("id", item.material_id)
        .single();
      const currentStock = freshMat ? Number(freshMat.stock_qty) : Number(material.stock_qty);

      await supabase
        .from("erp_materials")
        .update({
          stock_qty: Math.max(0, currentStock - item.weight),
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.material_id);

      const invoice_number = itemsToInsert.length > 1 ? `${baseInvNum}/${i + 1}` : baseInvNum;

      const invPayload: any = {
        invoice_number,
        transaction_id: txn.id,
        supplier_id,
        amount: total_amount,
        due_date: due_date || null,
        payment_method: payment_method || null,
        status: payment_method ? "paid" : "pending",
        paid_at: payment_method ? targetCreatedAt : null,
        created_at: targetCreatedAt,
        updated_at: new Date().toISOString(),
      };

      const { data: invoice, error: invoiceErr } = await supabase
        .from("erp_invoices")
        .insert(invPayload)
        .select()
        .single();

      if (invoiceErr) throw invoiceErr;

      if (i === 0) {
        firstTxn = {
          ...txn,
          material_name: material.name,
          supplier_name: supplier.name,
        };
        firstInvoice = invoice;
      }
    }

    res.json({
      success: true,
      message: "Scale transaction(s) and invoice(s) updated successfully.",
      transaction: firstTxn,
      invoice: firstInvoice,
    });
  } catch (err: any) {
    console.error("PUT /api/erp/transactions/:id error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/erp/transactions/:id — Delete B2B txn & reverse stock (Admin only)
erpRouter.delete("/transactions/:id", async (req, res) => {
  if (req.privilegedUser?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  try {
    // 1. Fetch txn
    const { data: txn, error: getErr } = await supabase.from("erp_transactions").select("*").eq("id", req.params.id).single();
    if (getErr || !txn) return res.status(404).json({ success: false, message: "Transaction not found." });

    const baseTxnNum = txn.txn_number.split("/")[0];

    // Find all siblings
    const { data: siblings, error: sibErr } = await supabase
      .from("erp_transactions")
      .select("*")
      .or(`txn_number.eq.${baseTxnNum},txn_number.like.${baseTxnNum}/%`);

    if (sibErr) throw sibErr;

    const oldSiblings = siblings || [];
    for (const sib of oldSiblings) {
      // Revert stock — restore material that was sold (undo the deduction)
      const { data: material } = await supabase
        .from("erp_materials")
        .select("stock_qty")
        .eq("id", sib.material_id)
        .single();

      if (material) {
        await supabase
          .from("erp_materials")
          .update({
            stock_qty: Number(material.stock_qty) + Number(sib.weight),
            updated_at: new Date().toISOString(),
          })
          .eq("id", sib.material_id);
      }

      // Delete associated invoice
      await supabase.from("erp_invoices").delete().eq("transaction_id", sib.id);

      // Delete transaction row
      const { error: deleteErr } = await supabase.from("erp_transactions").delete().eq("id", sib.id);
      if (deleteErr) throw deleteErr;
    }

    res.json({ success: true, message: "Transaction group and associated invoice(s) deleted. Stock reversed." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 5. INVOICES (B2B) ──────────────────────────────────────────────────────────

// GET /api/erp/invoices — List B2B invoices + summaries
erpRouter.get("/invoices", async (req, res) => {
  try {
    const { status, from_date, to_date, page = 1, limit = 20 } = req.query;

    let queryBuilder = supabase
      .from("erp_invoices")
      .select(`
        *,
        erp_suppliers(name, phone),
        erp_transactions(txn_number, weight, unit, price_per_unit, material_id, erp_materials(name))
      `);

    if (status) queryBuilder = queryBuilder.eq("status", String(status));
    if (from_date) queryBuilder = queryBuilder.gte("created_at", String(from_date));
    if (to_date) queryBuilder = queryBuilder.lte("created_at", `${to_date}T23:59:59.999Z`);

    const offset = (Number(page) - 1) * Number(limit);
    const { data, error } = await queryBuilder
      .order("created_at", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) throw error;

    const formatted = (data || []).map((i: any) => ({
      id: i.id,
      invoice_number: i.invoice_number,
      transaction_id: i.transaction_id,
      supplier_id: i.supplier_id,
      amount: Number(i.amount),
      status: i.status,
      due_date: i.due_date,
      paid_at: i.paid_at,
      payment_method: i.payment_method,
      notes: i.notes,
      created_at: i.created_at,
      supplier_name: i.erp_suppliers?.name || "",
      supplier_phone: i.erp_suppliers?.phone || "",
      txn_number: i.erp_transactions?.txn_number || "",
      weight: Number(i.erp_transactions?.weight || 0),
      unit: i.erp_transactions?.unit || "kg",
      price_per_unit: Number(i.erp_transactions?.price_per_unit || 0),
      material_name: i.erp_transactions?.erp_materials?.name || "",
    }));

    // Calculate summaries on-the-fly from database
    const { data: allInvoices, error: sumErr } = await supabase.from("erp_invoices").select("status, amount");
    const summary = {
      paid_count: 0,
      pending_count: 0,
      overdue_count: 0,
      paid_total: 0,
      pending_total: 0,
      overdue_total: 0,
    };

    if (!sumErr && allInvoices) {
      allInvoices.forEach((inv) => {
        const amt = Number(inv.amount);
        if (inv.status === "paid") {
          summary.paid_count++;
          summary.paid_total += amt;
        } else if (inv.status === "pending") {
          summary.pending_count++;
          summary.pending_total += amt;
        } else if (inv.status === "overdue") {
          summary.overdue_count++;
          summary.overdue_total += amt;
        }
      });
    }

    res.json({
      success: true,
      count: formatted.length,
      summary,
      invoices: formatted,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/erp/invoices/:id — Single invoice detail lookup
erpRouter.get("/invoices/:id", async (req, res) => {
  try {
    const { data: i, error } = await supabase
      .from("erp_invoices")
      .select(`
        *,
        erp_suppliers(*),
        erp_transactions(*, erp_materials(*))
      `)
      .eq("id", req.params.id)
      .single();

    if (error || !i) {
      return res.status(404).json({ success: false, message: "Invoice not found." });
    }

    const formatted = {
      id: i.id,
      invoice_number: i.invoice_number,
      transaction_id: i.transaction_id,
      supplier_id: i.supplier_id,
      amount: Number(i.amount),
      status: i.status,
      due_date: i.due_date,
      paid_at: i.paid_at,
      payment_method: i.payment_method,
      notes: i.notes,
      created_at: i.created_at,
      supplier_name: i.erp_suppliers?.name || "",
      supplier_phone: i.erp_suppliers?.phone || "",
      supplier_email: i.erp_suppliers?.email || "",
      supplier_address: i.erp_suppliers?.address || "",
      id_type: i.erp_suppliers?.id_type || "",
      id_number: i.erp_suppliers?.id_number || "",
      txn_number: i.erp_transactions?.txn_number || "",
      weight: Number(i.erp_transactions?.weight || 0),
      unit: i.erp_transactions?.unit || "kg",
      price_per_unit: Number(i.erp_transactions?.price_per_unit || 0),
      subtotal: Number(i.erp_transactions?.subtotal || 0),
      gst_rate: Number(i.erp_transactions?.gst_rate || 0),
      gst_amount: Number(i.erp_transactions?.gst_amount || 0),
      material_name: i.erp_transactions?.erp_materials?.name || "",
      category: i.erp_transactions?.erp_materials?.category || "",
    };

    res.json({ success: true, invoice: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/erp/invoices/:id/pay — Pay invoice
erpRouter.patch("/invoices/:id/pay", async (req, res) => {
  const parsed = payInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const { data: existing, error: getErr } = await supabase
      .from("erp_invoices")
      .select("status, notes")
      .eq("id", req.params.id)
      .single();

    if (getErr || !existing) return res.status(404).json({ success: false, message: "Invoice not found." });
    if (existing.status === "paid") return res.status(400).json({ success: false, message: "Invoice is already paid." });

    const notes = parsed.data.notes ? parsed.data.notes : existing.notes;

    const { data, error } = await supabase
      .from("erp_invoices")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
        payment_method: parsed.data.payment_method,
        notes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: "Invoice marked as paid.", invoice: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/erp/invoices/:id/status — Admin status overwrite
erpRouter.patch("/invoices/:id/status", async (req, res) => {
  if (req.privilegedUser?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  const status = req.body.status;
  if (!["pending", "paid", "overdue", "cancelled"].includes(status)) {
    return res.status(422).json({ success: false, message: "Invalid status." });
  }

  try {
    const { data, error } = await supabase
      .from("erp_invoices")
      .update({
        status,
        updated_at: new Date().toISOString(),
        ...(status === "paid" ? { paid_at: new Date().toISOString() } : {}),
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, message: `Invoice status updated to ${status}.`, invoice: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 6. PURCHASE RECEIPTS (B2C) ──────────────────────────────────────────────────

// GET /api/erp/purchase-receipts — List household receipts
erpRouter.get("/purchase-receipts", async (req, res) => {
  try {
    const { limit = 100, customer_id } = req.query;

    let queryBuilder = supabase
      .from("erp_purchase_receipts")
      .select(`
        *,
        erp_customers(name, phone),
        erp_materials(name, unit)
      `);

    if (customer_id) {
      queryBuilder = queryBuilder.eq("customer_id", String(customer_id));
    }

    const { data, error } = await queryBuilder
      .order("created_at", { ascending: false })
      .limit(Number(limit));

    if (error) throw error;

    const formatted = (data || []).map((pr: any) => ({
      id: pr.id,
      receipt_number: pr.receipt_number,
      customer_id: pr.customer_id,
      material_id: pr.material_id,
      weight: Number(pr.weight),
      unit: pr.unit,
      price_per_unit: Number(pr.price_per_unit),
      total_amount: Number(pr.total_amount),
      payment_method: pr.payment_method,
      notes: pr.notes,
      created_at: pr.created_at,
      customer_name: pr.erp_customers?.name || "Walk-in Customer",
      customer_phone: pr.erp_customers?.phone || "",
      material_name: pr.erp_materials?.name || "",
      material_unit: pr.erp_materials?.unit || "kg",
    }));

    res.json({ success: true, receipts: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/erp/purchase-receipts — Add household scale entry & update stock
erpRouter.post("/purchase-receipts", async (req, res) => {
  const parsed = purchaseReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  const { customer_id, payment_method, notes, created_at, items } = parsed.data;

  try {
    let itemsToInsert: Array<{ material_id: string; weight: number; price_per_unit: number }> = [];

    if (items && items.length > 0) {
      itemsToInsert = items;
    } else {
      if (!parsed.data.material_id || !parsed.data.weight || parsed.data.price_per_unit === undefined) {
        return res.status(422).json({ success: false, message: "Either items or material_id, weight and price_per_unit are required." });
      }
      itemsToInsert = [{
        material_id: parsed.data.material_id,
        weight: parsed.data.weight,
        price_per_unit: parsed.data.price_per_unit
      }];
    }

    // 1. Generate sequential base receipt number (simulating sequences)
    const { count: receiptCount, error: rCountErr } = await supabase.from("erp_purchase_receipts").select("*", { count: "exact", head: true });
    if (rCountErr) throw rCountErr;
    const baseReceiptNum = `RCP-${String((receiptCount || 0) + 1001)}`;

    let cumulativeTotal = 0;
    let firstReceipt: any = null;

    // 2. Loop insert each item
    for (let i = 0; i < itemsToInsert.length; i++) {
      const item = itemsToInsert[i];

      // Verify material exists
      const { data: material, error: mErr } = await supabase
        .from("erp_materials")
        .select("id, name, unit, stock_qty")
        .eq("id", item.material_id)
        .single();
      if (mErr || !material) return res.status(404).json({ success: false, message: `Material not found for ID: ${item.material_id}` });

      const total_amount = Number((item.weight * item.price_per_unit).toFixed(2));
      cumulativeTotal += total_amount;

      const receipt_number = itemsToInsert.length > 1 ? `${baseReceiptNum}/${i + 1}` : baseReceiptNum;

      const insertPayload: any = {
        receipt_number,
        customer_id: customer_id || null,
        material_id: item.material_id,
        weight: item.weight,
        unit: material.unit,
        price_per_unit: item.price_per_unit,
        total_amount,
        payment_method,
        notes: notes || null,
        created_by: req.privilegedUser?.id || null,
      };

      if (created_at) {
        insertPayload.created_at = created_at;
      }

      const { data: receipt, error: insertErr } = await supabase
        .from("erp_purchase_receipts")
        .insert(insertPayload)
        .select()
        .single();

      if (insertErr) throw insertErr;

      // Update material stock
      await supabase
        .from("erp_materials")
        .update({
          stock_qty: Number(material.stock_qty) + item.weight,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.material_id);

      // Refresh weighted average buy cost for this material
      await refreshAvgCostPerUnit(item.material_id);

      if (i === 0) {
        firstReceipt = receipt;
      }
    }

    // 3. Update customer stats if customer provided
    if (customer_id) {
      const receiptDate = created_at || new Date().toISOString();
      const { data: customer } = await supabase.from("erp_customers").select("total_visits, total_paid").eq("id", customer_id).single();
      if (customer) {
        await supabase
          .from("erp_customers")
          .update({
            total_visits: (customer.total_visits || 0) + 1,
            total_paid: Number(customer.total_paid || 0) + cumulativeTotal,
            last_receipt_date: receiptDate,
            updated_at: new Date().toISOString(),
          })
          .eq("id", customer_id);
      }
    }

    // 4. Fetch fully formatted first receipt to return
    const { data: fullReceipt, error: getFullErr } = await supabase
      .from("erp_purchase_receipts")
      .select(`
        *,
        erp_customers(name, phone),
        erp_materials(name, unit)
      `)
      .eq("id", firstReceipt.id)
      .single();

    if (getFullErr) throw getFullErr;

    const formatted = {
      ...fullReceipt,
      customer_name: fullReceipt.erp_customers?.name || "Walk-in Customer",
      customer_phone: fullReceipt.erp_customers?.phone || "",
      material_name: fullReceipt.erp_materials?.name || "",
      material_unit: fullReceipt.erp_materials?.unit || "kg",
    };

    res.status(201).json({ success: true, receipt: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/erp/purchase-receipts/:id — Edit B2C scale collection receipt
erpRouter.put("/purchase-receipts/:id", async (req, res) => {
  const parsed = purchaseReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  const receiptId = req.params.id;
  const { customer_id, payment_method, notes, created_at, items } = parsed.data;

  try {
    // 1. Fetch old receipt details
    const { data: oldReceipt, error: fetchErr } = await supabase
      .from("erp_purchase_receipts")
      .select("*")
      .eq("id", receiptId)
      .single();

    if (fetchErr || !oldReceipt) {
      return res.status(404).json({ success: false, message: "Receipt not found" });
    }

    const baseReceiptNum = oldReceipt.receipt_number.split("/")[0];

    // Find all siblings using TWO separate queries to avoid unreliable .or() + LIKE with % wildcard
    const { data: exactMatches, error: exactErr } = await supabase
      .from("erp_purchase_receipts")
      .select("*")
      .eq("receipt_number", baseReceiptNum);

    const { data: suffixMatches, error: suffixErr } = await supabase
      .from("erp_purchase_receipts")
      .select("*")
      .like("receipt_number", `${baseReceiptNum}/%`);

    if (exactErr) throw exactErr;
    if (suffixErr) throw suffixErr;

    const oldSiblings = [...(exactMatches || []), ...(suffixMatches || [])];

    // 2. Normalize and validate ALL new items FIRST before modifying DB
    let itemsToInsert: Array<{ material_id: string; weight: number; price_per_unit: number }> = [];

    if (items && items.length > 0) {
      itemsToInsert = items;
    } else {
      if (!parsed.data.material_id || !parsed.data.weight || parsed.data.price_per_unit === undefined) {
        return res.status(422).json({ success: false, message: "Either items or material_id, weight and price_per_unit are required." });
      }
      itemsToInsert = [{
        material_id: parsed.data.material_id,
        weight: parsed.data.weight,
        price_per_unit: parsed.data.price_per_unit
      }];
    }

    // Verify all new materials exist BEFORE touching DB
    const validatedMaterials: Record<string, any> = {};
    for (const item of itemsToInsert) {
      const { data: mat, error: mErr } = await supabase
        .from("erp_materials")
        .select("id, name, unit, stock_qty")
        .eq("id", item.material_id)
        .single();
      if (mErr || !mat) return res.status(404).json({ success: false, message: `Material not found: ${item.material_id}` });
      validatedMaterials[item.material_id] = mat;
    }

    // Preserve creation date unless explicitly changed
    let targetCreatedAt = oldReceipt.created_at;
    if (created_at) {
      const pDate = new Date(created_at);
      if (!isNaN(pDate.getTime())) {
        targetCreatedAt = pDate.toISOString();
      }
    }

    // 3. Revert stock for all old siblings and delete them
    let oldCumulativeTotal = 0;
    const oldCustId = oldReceipt.customer_id;

    for (const sib of oldSiblings) {
      oldCumulativeTotal += Number(sib.total_amount);

      const { data: material } = await supabase
        .from("erp_materials")
        .select("stock_qty")
        .eq("id", sib.material_id)
        .single();
      if (material) {
        await supabase
          .from("erp_materials")
          .update({
            stock_qty: Math.max(0, Number(material.stock_qty) - Number(sib.weight)),
            updated_at: new Date().toISOString(),
          })
          .eq("id", sib.material_id);
      }

      await supabase.from("erp_purchase_receipts").delete().eq("id", sib.id);
    }

    // Revert old customer paid amount & visit count
    if (oldCustId && oldCumulativeTotal > 0) {
      const { data: oldCust } = await supabase
        .from("erp_customers")
        .select("total_visits, total_paid")
        .eq("id", oldCustId)
        .single();
      if (oldCust) {
        await supabase
          .from("erp_customers")
          .update({
            total_visits: Math.max(0, Number(oldCust.total_visits || 0) - 1),
            total_paid: Math.max(0, Number(oldCust.total_paid || 0) - oldCumulativeTotal),
            updated_at: new Date().toISOString(),
          })
          .eq("id", oldCustId);
      }
    }

    // 4. Insert new items — with rollback: if any insert fails, re-insert old siblings
    let newCumulativeTotal = 0;
    let firstNewReceipt: any = null;
    const insertedNewIds: string[] = [];

    try {
      for (let i = 0; i < itemsToInsert.length; i++) {
        const item = itemsToInsert[i];
        const material = validatedMaterials[item.material_id];

        const total_amount = Number((item.weight * item.price_per_unit).toFixed(2));
        newCumulativeTotal += total_amount;

        const receipt_number = itemsToInsert.length > 1 ? `${baseReceiptNum}/${i + 1}` : baseReceiptNum;

        const insertPayload: any = {
          receipt_number,
          customer_id: customer_id || null,
          material_id: item.material_id,
          weight: item.weight,
          unit: material.unit,
          price_per_unit: item.price_per_unit,
          total_amount,
          payment_method,
          notes: notes || null,
          created_by: req.privilegedUser?.id || oldReceipt.created_by || null,
          created_at: targetCreatedAt,
        };


        const { data: receipt, error: insertErr } = await supabase
          .from("erp_purchase_receipts")
          .insert(insertPayload)
          .select()
          .single();

        if (insertErr) throw insertErr;

        insertedNewIds.push(receipt.id);

        // Update stock for new item
        const { data: freshMat } = await supabase
          .from("erp_materials")
          .select("stock_qty")
          .eq("id", item.material_id)
          .single();
        const currentStock = freshMat ? Number(freshMat.stock_qty) : Number(material.stock_qty);

        await supabase
          .from("erp_materials")
          .update({
            stock_qty: currentStock + item.weight,
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.material_id);

        // Refresh weighted average buy cost after each item is inserted
        await refreshAvgCostPerUnit(item.material_id);

        if (i === 0) {
          firstNewReceipt = receipt;
        }
      }
    } catch (insertErr: any) {
      // ROLLBACK: new inserts failed — delete any partially inserted new rows
      for (const newId of insertedNewIds) {
        await supabase.from("erp_purchase_receipts").delete().eq("id", newId);
      }

      // RESTORE: re-insert all old siblings so data is not lost
      for (const sib of oldSiblings) {
        const { id: _id, ...sibData } = sib as any;
        await supabase.from("erp_purchase_receipts").insert({ ...sibData, id: sib.id });

        // Restore stock
        const { data: mat } = await supabase.from("erp_materials").select("stock_qty").eq("id", sib.material_id).single();
        if (mat) {
          await supabase.from("erp_materials").update({
            stock_qty: Number(mat.stock_qty) + Number(sib.weight),
            updated_at: new Date().toISOString(),
          }).eq("id", sib.material_id);
        }
      }

      // Restore customer stats
      if (oldCustId && oldCumulativeTotal > 0) {
        const { data: cust } = await supabase.from("erp_customers").select("total_visits, total_paid").eq("id", oldCustId).single();
        if (cust) {
          await supabase.from("erp_customers").update({
            total_visits: Number(cust.total_visits || 0) + 1,
            total_paid: Number(cust.total_paid || 0) + oldCumulativeTotal,
            updated_at: new Date().toISOString(),
          }).eq("id", oldCustId);
        }
      }

      console.error("PUT /api/erp/purchase-receipts/:id — insert failed, rolled back:", insertErr);
      return res.status(500).json({ success: false, message: `Failed to save updated receipt: ${insertErr.message}. Original data has been restored.` });
    }

    // 5. Update new customer stats
    const newCustId = customer_id || null;
    if (newCustId) {
      const receiptDate = targetCreatedAt || new Date().toISOString();
      const { data: customer } = await supabase
        .from("erp_customers")
        .select("total_visits, total_paid")
        .eq("id", newCustId)
        .single();
      if (customer) {
        await supabase
          .from("erp_customers")
          .update({
            total_visits: (customer.total_visits || 0) + 1,
            total_paid: Number(customer.total_paid || 0) + newCumulativeTotal,
            last_receipt_date: targetCreatedAt,
            updated_at: new Date().toISOString(),
          })
          .eq("id", newCustId);
      }
    }

    // 6. Fetch all updated receipt rows to build the full grouped response
    const { data: allNewRows, error: fetchNewErr } = await supabase
      .from("erp_purchase_receipts")
      .select(`
        *,
        erp_customers(name, phone),
        erp_materials(name, unit)
      `)
      .like("receipt_number", `${baseReceiptNum}%`)
      .order("receipt_number", { ascending: true });

    if (fetchNewErr) throw fetchNewErr;

    const formattedRows = (allNewRows || []).map((pr: any) => ({
      id: pr.id,
      receipt_number: pr.receipt_number,
      customer_id: pr.customer_id,
      material_id: pr.material_id,
      weight: Number(pr.weight),
      unit: pr.unit,
      price_per_unit: Number(pr.price_per_unit),
      total_amount: Number(pr.total_amount),
      payment_method: pr.payment_method,
      notes: pr.notes,
      created_at: pr.created_at,
      customer_name: pr.erp_customers?.name || "Walk-in Customer",
      customer_phone: pr.erp_customers?.phone || "",
      material_name: pr.erp_materials?.name || "",
      material_unit: pr.erp_materials?.unit || "kg",
    }));

    // Return the first new receipt + all rows (so frontend can re-group properly)
    const firstFormatted = formattedRows[0] || {
      ...firstNewReceipt,
      customer_name: "Walk-in Customer",
      customer_phone: "",
      material_name: "",
      material_unit: "kg",
    };

    res.json({ success: true, receipt: firstFormatted, receipts: formattedRows });
  } catch (err: any) {
    console.error("PUT /api/erp/purchase-receipts/:id error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});



// DELETE /api/erp/purchase-receipts/:id — Delete household receipt & reverse stock (Admin only)
erpRouter.delete("/purchase-receipts/:id", async (req, res) => {
  if (req.privilegedUser?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  try {
    // 1. Get receipt details
    const { data: r, error: rErr } = await supabase.from("erp_purchase_receipts").select("*").eq("id", req.params.id).single();
    if (rErr || !r) return res.status(404).json({ success: false, message: "Receipt not found" });

    const baseReceiptNum = r.receipt_number.split("/")[0];

    // Find all siblings under the same base receipt number
    const { data: siblings, error: sibErr } = await supabase
      .from("erp_purchase_receipts")
      .select("*")
      .or(`receipt_number.eq.${baseReceiptNum},receipt_number.like.${baseReceiptNum}/%`);

    if (sibErr) throw sibErr;

    const allReceipts = siblings || [];
    let cumulativeTotal = 0;

    for (const receipt of allReceipts) {
      cumulativeTotal += Number(receipt.total_amount);

      // Reverse stock
      const { data: material } = await supabase.from("erp_materials").select("stock_qty").eq("id", receipt.material_id).single();
      if (material) {
        await supabase
          .from("erp_materials")
          .update({
            stock_qty: Math.max(0, Number(material.stock_qty) - Number(receipt.weight)),
            updated_at: new Date().toISOString(),
          })
          .eq("id", receipt.material_id);
      }

      // Delete receipt record
      await supabase.from("erp_purchase_receipts").delete().eq("id", receipt.id);

      // Refresh weighted average buy cost after deletion
      await refreshAvgCostPerUnit(receipt.material_id);
    }

    // 3. Reverse customer stats
    if (r.customer_id && cumulativeTotal > 0) {
      const { data: customer } = await supabase.from("erp_customers").select("total_visits, total_paid").eq("id", r.customer_id).single();
      if (customer) {
        await supabase
          .from("erp_customers")
          .update({
            total_visits: Math.max(0, Number(customer.total_visits || 0) - 1),
            total_paid: Math.max(0, Number(customer.total_paid || 0) - cumulativeTotal),
            updated_at: new Date().toISOString(),
          })
          .eq("id", r.customer_id);
      }
    }

    res.json({ success: true, message: "Receipt (and all associated materials) deleted and stock reversed." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 7. WHATSAPP & PDF SIMULATOR (MOCKED) ────────────────────────────────────────

// POST /api/erp/whatsapp/send/:transactionId — Send Transaction PDF Receipt via WhatsApp (Twilio / Mock)
erpRouter.post("/whatsapp/send/:transactionId", async (req, res) => {
  try {
    // 1. Fetch transaction details
    const { data: t, error } = await supabase
      .from("erp_transactions")
      .select(`
        *,
        erp_suppliers(*),
        erp_materials(*),
        erp_invoices(*)
      `)
      .eq("id", req.params.transactionId)
      .single();

    if (error || !t) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    if (!t.erp_suppliers?.phone) {
      return res.status(400).json({
        success: false,
        message: "This supplier has no phone number on record. Update supplier details first.",
      });
    }

    const invoices = Array.isArray(t.erp_invoices) ? t.erp_invoices[0] : t.erp_invoices;
    const phone = t.erp_suppliers.phone;

    // Simulate PDF generation by creating a mock url
    const mockPdfUrl = `https://mtzvoeohbifxmertnwwy.supabase.co/storage/v1/object/public/invoices/mock_invoice_${invoices?.invoice_number || t.txn_number}.pdf`;

    const supplierName = t.erp_suppliers.name;
    const materialName = t.erp_materials.name;
    const weight = t.weight;
    const unit = t.unit || "kg";
    const totalAmount = t.total_amount;
    const txnNumber = t.txn_number;

    // Construct the WhatsApp message body
    const body = `Hello ${supplierName},\n\nYour transaction ${txnNumber} has been recorded.\nMaterial: ${materialName}\nWeight: ${weight} ${unit}\nTotal Amount: ₹${totalAmount}\n\nInvoice PDF: ${mockPdfUrl}\n\nThank you for partnering with The Scrap Co.!`;

    // Send the message using the Twilio client
    const result = await sendWhatsAppMessage(phone, body);

    // Insert log to DB
    const { error: logErr } = await supabase.from("erp_whatsapp_logs").insert({
      transaction_id: t.id,
      supplier_phone: phone,
      status: result.success ? "sent" : "failed",
      message_id: result.messageId || null,
      provider: result.isMocked ? "mock" : "twilio",
      pdf_url: mockPdfUrl,
      error: result.error || null,
    });

    if (logErr) throw logErr;

    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: `Failed to dispatch WhatsApp message via Twilio: ${result.error}`,
        pdfUrl: mockPdfUrl,
      });
    }

    res.json({
      success: true,
      message: result.isMocked
        ? `WhatsApp receipt simulated successfully and logged (Mock Provider) to ${phone}`
        : `WhatsApp receipt dispatched successfully via Twilio to ${phone}`,
      pdfUrl: mockPdfUrl,
    });
  } catch (err: any) {
    console.error("POST /api/erp/whatsapp/send error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

erpRouter.get("/whatsapp/logs", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("erp_whatsapp_logs")
      .select(`
        *,
        erp_transactions(txn_number, erp_suppliers(name))
      `)
      .order("sent_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    const formatted = (data || []).map((wl: any) => ({
      id: wl.id,
      transaction_id: wl.transaction_id,
      supplier_phone: wl.supplier_phone,
      status: wl.status,
      message_id: wl.message_id,
      provider: wl.provider,
      pdf_url: wl.pdf_url,
      error: wl.error,
      sent_at: wl.sent_at,
      txn_number: wl.erp_transactions?.txn_number || "",
      supplier_name: wl.erp_transactions?.erp_suppliers?.name || "Unknown Supplier",
    }));

    res.json({ success: true, logs: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 8. DASHBOARD ──────────────────────────────────────────────────────────────

// GET /api/erp/dashboard — Aggregated dashboard statistics for charts & summaries
// Query params:
//   period:  "month" | "quarter" | "year"  (default: "month" rolling 30 days)
//   year:    e.g. 2026                     (default: current year)
//   month:   1–12                          (only for period=month; default: current month)
//   quarter: 1–4                           (only for period=quarter; default: current quarter)
erpRouter.get("/dashboard", async (req, res) => {
  try {
    // ── Period resolution ──────────────────────────────────────────────────────
    const period   = (req.query.period as string) || "month";
    const now      = new Date();
    const reqYear  = req.query.year    ? Number(req.query.year)    : now.getFullYear();
    const reqMonth = req.query.month   ? Number(req.query.month)   : now.getMonth() + 1;
    const reqQ     = req.query.quarter ? Number(req.query.quarter) : Math.ceil((now.getMonth() + 1) / 3);

    let periodStart: Date;
    let periodEnd: Date;
    let periodLabel: string;

    if (period === "year") {
      periodStart = new Date(reqYear, 0, 1);
      periodEnd   = new Date(reqYear + 1, 0, 1);
      periodLabel = `FY ${reqYear}`;
    } else if (period === "quarter") {
      const qStart = (reqQ - 1) * 3;
      periodStart  = new Date(reqYear, qStart, 1);
      periodEnd    = new Date(reqYear, qStart + 3, 1);
      const qNames = ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"];
      periodLabel  = `Q${reqQ} ${reqYear} (${qNames[reqQ - 1]})`;
    } else {
      // month mode — rolling 30 days by default; explicit year+month = calendar month
      if (req.query.year || req.query.month) {
        periodStart = new Date(reqYear, reqMonth - 1, 1);
        periodEnd   = new Date(reqYear, reqMonth, 1);
        periodLabel = new Date(reqYear, reqMonth - 1, 1)
          .toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      } else {
        const calStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const rolling  = new Date(now);
        rolling.setDate(rolling.getDate() - 30);
        periodStart = rolling < calStart ? rolling : calStart;
        periodEnd   = new Date(now);
        periodEnd.setDate(periodEnd.getDate() + 1);
        periodLabel = "Last 30 days";
      }
    }

    const startISO = periodStart.toISOString();
    const endISO   = periodEnd.toISOString();

    // ── 1. Stat card aggregates for selected period ────────────────────────────
    const [{ data: txnsPeriod, error: txnErr }, { data: buysPeriod }] = await Promise.all([
      supabase
        .from("erp_transactions")
        .select("total_amount, weight")
        .gte("created_at", startISO)
        .lt("created_at", endISO),
      supabase
        .from("erp_purchase_receipts")
        .select("total_amount, weight")
        .gte("created_at", startISO)
        .lt("created_at", endISO),
    ]);

    if (txnErr) throw txnErr;

    const revenueThisMonth         = (txnsPeriod || []).reduce((s, t) => s + Number(t.total_amount), 0);
    const weightSoldThisMonth      = (txnsPeriod || []).reduce((s, t) => s + Number(t.weight), 0);
    const txnsCountThisMonth       = (txnsPeriod || []).length;                          // B2B scale entries
    const buyCostThisMonth         = (buysPeriod || []).reduce((s, t) => s + Number(t.total_amount), 0);
    const weightCollectedThisMonth = (buysPeriod || []).reduce((s, t) => s + Number((t as any).weight), 0);
    const receiptCountThisMonth    = (buysPeriod || []).length;                          // B2C collections

    // All-time weighted avg buy price per material (for COGS)
    const { data: allBuys } = await supabase
      .from("erp_purchase_receipts")
      .select("material_id, weight, total_amount");

    const avgBuyMap: Record<string, { total_cost: number; total_weight: number }> = {};
    (allBuys || []).forEach((r: any) => {
      if (!avgBuyMap[r.material_id]) avgBuyMap[r.material_id] = { total_cost: 0, total_weight: 0 };
      avgBuyMap[r.material_id].total_cost   += Number(r.total_amount);
      avgBuyMap[r.material_id].total_weight += Number(r.weight);
    });

    const { data: txnsPeriodDetail } = await supabase
      .from("erp_transactions")
      .select("material_id, weight")
      .gte("created_at", startISO)
      .lt("created_at", endISO);

    const cogsThisMonth = (txnsPeriodDetail || []).reduce((sum: number, t: any) => {
      const avg = avgBuyMap[t.material_id];
      const avgPrice = avg && avg.total_weight > 0 ? avg.total_cost / avg.total_weight : 0;
      return sum + Number(t.weight) * avgPrice;
    }, 0);

    const profitLoss = Number((revenueThisMonth - cogsThisMonth).toFixed(2));

    // ── 2. Low stock alerts ────────────────────────────────────────────────────
    const { data: lowStock, error: stockErr } = await supabase
      .from("erp_materials")
      .select("id, name, stock_qty, min_threshold, color_hex, unit")
      .eq("is_active", true);

    if (stockErr) throw stockErr;

    const lowStockAlerts = (lowStock || [])
      .filter((m) => Number(m.stock_qty) <= Number(m.min_threshold))
      .sort((a, b) => {
        const tA = Number(a.min_threshold) || 1;
        const tB = Number(b.min_threshold) || 1;
        return Number(a.stock_qty) / tA - Number(b.stock_qty) / tB;
      });

    // ── 3. Last 10 recent B2B transactions (always unfiltered) ────────────────
    const { data: recent, error: recentErr } = await supabase
      .from("erp_transactions")
      .select(`
        id, txn_number, weight, unit, total_amount, created_at,
        erp_suppliers(name),
        erp_materials(name, color_hex),
        erp_invoices(status, invoice_number)
      `)
      .order("created_at", { ascending: false })
      .limit(10);

    if (recentErr) throw recentErr;

    const formattedRecent = (recent || []).map((t: any) => {
      const invoices = Array.isArray(t.erp_invoices) ? t.erp_invoices[0] : t.erp_invoices;
      return {
        id: t.id,
        txn_number: t.txn_number,
        weight: Number(t.weight),
        unit: t.unit,
        total_amount: Number(t.total_amount),
        created_at: t.created_at,
        supplier_name: t.erp_suppliers?.name || "Walk-in Supplier",
        material_name: t.erp_materials?.name || "",
        color_hex: t.erp_materials?.color_hex || "#f5a623",
        invoice_status: invoices?.status || "pending",
        invoice_number: invoices?.invoice_number || "",
      };
    });

    // ── 4. Invoice summary (all-time) ─────────────────────────────────────────
    const { data: invoices, error: invErr } = await supabase.from("erp_invoices").select("status, amount");
    if (invErr) throw invErr;

    const invoice_summary = { pending_count: 0, overdue_count: 0, pending_amount: 0, overdue_amount: 0 };
    (invoices || []).forEach((inv) => {
      const amt = Number(inv.amount);
      if (inv.status === "pending")      { invoice_summary.pending_count++; invoice_summary.pending_amount += amt; }
      else if (inv.status === "overdue") { invoice_summary.overdue_count++; invoice_summary.overdue_amount += amt; }
    });

    // ── 5. 6-month monthly trend chart (fixed window, always) ─────────────────
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const [{ data: trendsData, error: trendErr }, { data: sellTrendsData }] = await Promise.all([
      supabase.from("erp_transactions").select("total_amount, created_at").gte("created_at", sixMonthsAgo.toISOString()),
      supabase.from("erp_purchase_receipts").select("total_amount, created_at").gte("created_at", sixMonthsAgo.toISOString()),
    ]);

    if (trendErr) throw trendErr;

    // Key by YYYY-MM to avoid Dec/Jun collision across year boundary
    const monthsMap: Record<string, { purchase_revenue: number; sell_revenue: number; transaction_count: number; label: string }> = {};
    const monthsOrder: string[] = [];

    for (let i = 5; i >= 0; i--) {
      const d   = new Date();
      d.setMonth(d.getMonth() - i);
      const key   = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", { month: "short" });
      monthsMap[key] = { purchase_revenue: 0, sell_revenue: 0, transaction_count: 0, label };
      monthsOrder.push(key);
    }

    (trendsData || []).forEach((t) => {
      const d   = new Date(t.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (monthsMap[key]) { monthsMap[key].purchase_revenue += Number(t.total_amount); monthsMap[key].transaction_count++; }
    });

    (sellTrendsData || []).forEach((t) => {
      const d   = new Date(t.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (monthsMap[key]) monthsMap[key].sell_revenue += Number(t.total_amount);
    });

    const monthly_trend = monthsOrder.map((key) => ({
      month:             monthsMap[key].label,
      total_revenue:     monthsMap[key].purchase_revenue,
      purchase_revenue:  monthsMap[key].purchase_revenue,
      sell_revenue:      monthsMap[key].sell_revenue,
      transaction_count: monthsMap[key].transaction_count,
    }));

    // ── 6. Top 5 materials by revenue in selected period ──────────────────────
    const { data: topMatsData, error: topMatsErr } = await supabase
      .from("erp_transactions")
      .select("total_amount, weight, erp_materials(name, color_hex)")
      .gte("created_at", startISO)
      .lt("created_at", endISO);

    if (topMatsErr) throw topMatsErr;

    const matRevMap: Record<string, { name: string; color_hex: string; revenue: number; weight_collected: number }> = {};
    (topMatsData || []).forEach((t: any) => {
      const name = t.erp_materials?.name;
      if (name) {
        if (!matRevMap[name]) matRevMap[name] = { name, color_hex: t.erp_materials.color_hex || "#f5a623", revenue: 0, weight_collected: 0 };
        matRevMap[name].revenue          += Number(t.total_amount);
        matRevMap[name].weight_collected += Number(t.weight);
      }
    });

    const top_materials = Object.values(matRevMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // ── 7. Material P&L (all-time) ────────────────────────────────────────────
    const [{ data: allReceipts }, { data: allTxns }] = await Promise.all([
      supabase.from("erp_purchase_receipts").select("material_id, weight, total_amount, erp_materials(name, color_hex)"),
      supabase.from("erp_transactions").select("material_id, weight, total_amount, erp_materials(name, color_hex)"),
    ]);

    const pnlMap: Record<string, { material_id: string; material_name: string; color_hex: string; buy_weight: number; buy_cost: number; sell_weight: number; sell_revenue: number }> = {};

    (allReceipts || []).forEach((r: any) => {
      const id = r.material_id; const name = r.erp_materials?.name || "Unknown"; const color = r.erp_materials?.color_hex || "#ccc";
      if (!pnlMap[id]) pnlMap[id] = { material_id: id, material_name: name, color_hex: color, buy_weight: 0, buy_cost: 0, sell_weight: 0, sell_revenue: 0 };
      pnlMap[id].buy_weight += Number(r.weight); pnlMap[id].buy_cost += Number(r.total_amount);
    });

    (allTxns || []).forEach((t: any) => {
      const id = t.material_id; const name = t.erp_materials?.name || "Unknown"; const color = t.erp_materials?.color_hex || "#ccc";
      if (!pnlMap[id]) pnlMap[id] = { material_id: id, material_name: name, color_hex: color, buy_weight: 0, buy_cost: 0, sell_weight: 0, sell_revenue: 0 };
      pnlMap[id].sell_weight += Number(t.weight); pnlMap[id].sell_revenue += Number(t.total_amount);
    });

    const material_pnl = Object.values(pnlMap).map((m) => {
      const unsold_weight     = Math.max(0, m.buy_weight - m.sell_weight);
      const avg_buy_price     = m.buy_weight > 0 ? m.buy_cost / m.buy_weight : 0;
      const cogs              = Number((m.sell_weight * avg_buy_price).toFixed(2));
      const profit_loss       = Number((m.sell_revenue - cogs).toFixed(2));
      const inventory_value   = Number((unsold_weight * avg_buy_price).toFixed(2));
      const profit_margin_pct = cogs > 0 ? Number(((profit_loss / cogs) * 100).toFixed(1)) : 0;
      return { ...m, avg_buy_price: Number(avg_buy_price.toFixed(2)), cogs, profit_loss, profit_margin_pct, unsold_weight, inventory_value };
    }).sort((a, b) => b.profit_loss - a.profit_loss);

    // ── Response ──────────────────────────────────────────────────────────────
    res.json({
      success: true,
      dashboard: {
        revenue: {
          revenue_this_month:        revenueThisMonth,
          weight_this_month:         weightCollectedThisMonth,
          weight_sold_this_month:    weightSoldThisMonth,
          txn_count_this_month:      txnsCountThisMonth,       // B2B scale entries
          receipt_count_this_month:  receiptCountThisMonth,    // B2C collections done
          buy_cost_this_month:       buyCostThisMonth,
          profit_loss:               profitLoss,
          period_label:              periodLabel,
          period_start:              startISO,
          period_end:                endISO,
        },
        low_stock_alerts:    lowStockAlerts,
        recent_transactions: formattedRecent,
        monthly_trend,
        top_materials,
        invoice_summary,
        material_pnl,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});
