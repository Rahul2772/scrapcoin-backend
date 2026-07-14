import { Router } from "express";
import { z } from "zod";
import { requireAdminOrChampion } from "../middleware/requireAdminOrChampion.js";
import { supabase } from "../lib/supabase.js";
import { sendWhatsAppMessage } from "../lib/twilio.js";

export const erpRouter = Router();

// Secure all ERP endpoints under admin / champion check
erpRouter.use(requireAdminOrChampion);

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
});

const transactionSchema = z.object({
  supplier_id: z.string().uuid(),
  notes: z.string().trim().optional().nullable(),
  due_date: z.string().optional().nullable(),
  payment_method: z.string().optional().nullable(),
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
});

const purchaseReceiptSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  payment_method: z.string().optional().default("cash"),
  notes: z.string().trim().optional().nullable(),
  created_at: z.string().trim().optional().nullable(),
  // Single entry fallback
  material_id: z.string().uuid().optional(),
  weight: z.number().positive().optional(),
  price_per_unit: z.number().nonnegative().optional(),
  // Multi entry
  items: z.array(z.object({
    material_id: z.string().uuid(),
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

// ── 2. SUPPLIERS ──────────────────────────────────────────────────────────────

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

    const enriched = await Promise.all(
      (customers || []).map(async (c) => {
        const { count, error: countErr } = await supabase
          .from("erp_purchase_receipts")
          .select("*", { count: "exact", head: true })
          .eq("customer_id", c.id);

        const { data: receipts } = await supabase
          .from("erp_purchase_receipts")
          .select("total_amount")
          .eq("customer_id", c.id);

        const totalPaid = (receipts || []).reduce((sum, r) => sum + Number(r.total_amount), 0);

        return {
          ...c,
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

    const formattedReceipts = (receipts || []).map((r) => ({
      ...r,
      material_name: r.erp_materials?.name || "Scrap Material",
    }));

    res.json({ success: true, customer, receipts: formattedReceipts });
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
    const { data, error } = await supabase
      .from("erp_customers")
      .insert({
        name: parsed.data.name,
        phone: parsed.data.phone || null,
        whatsapp: parsed.data.whatsapp || null,
        upi: parsed.data.upi || null,
        address: parsed.data.address || null,
        id_type: parsed.data.id_type || "Aadhaar",
        id_number: parsed.data.id_number || null,
        notes: parsed.data.notes || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, customer: data });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/erp/customers/:id — Edit customer
erpRouter.put("/customers/:id", async (req, res) => {
  const parsed = customerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const { data, error } = await supabase
      .from("erp_customers")
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, customer: data });
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

  const { supplier_id, notes, due_date, payment_method, items } = parsed.data;

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

    // 4. Loop insert B2B items
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
      const { data: txn, error: insertErr } = await supabase
        .from("erp_transactions")
        .insert({
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
        })
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

      const invoice_number = itemsToInsert.length > 1 ? `${baseInvNum}/${i + 1}` : baseInvNum;

      // Auto-create invoice
      const { data: invoice, error: invoiceErr } = await supabase
        .from("erp_invoices")
        .insert({
          invoice_number,
          transaction_id: txn.id,
          supplier_id,
          amount: total_amount,
          due_date: due_date || null,
          payment_method: payment_method || null,
          status: payment_method ? "paid" : "pending",
          paid_at: payment_method ? new Date().toISOString() : null,
        })
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
      message: "Scale transaction(s) recorded and invoice(s) created.",
      transaction: firstTxn,
      invoice: firstInvoice,
    });
  } catch (err: any) {
    console.error("POST /api/erp/transactions error:", err);
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

    // 2. Fetch material stock
    const { data: material, error: mErr } = await supabase.from("erp_materials").select("stock_qty").eq("id", txn.material_id).single();
    if (mErr || !material) throw mErr;

    // 3. Reverse stock
    await supabase
      .from("erp_materials")
      .update({
        stock_qty: Math.max(0, Number(material.stock_qty) - Number(txn.weight)),
        updated_at: new Date().toISOString(),
      })
      .eq("id", txn.material_id);

    // 4. Delete invoice & transaction (invoice cascading will occur if defined, but we delete manually to be safe)
    await supabase.from("erp_invoices").delete().eq("transaction_id", req.params.id);
    const { error: deleteErr } = await supabase.from("erp_transactions").delete().eq("id", req.params.id);

    if (deleteErr) throw deleteErr;

    res.json({ success: true, message: "Transaction and associated invoice deleted. Stock reversed." });
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
        created_by: req.privilegedUser?.id,
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

      if (i === 0) {
        firstReceipt = receipt;
      }
    }

    // 3. Update customer stats if customer provided
    if (customer_id && cumulativeTotal > 0) {
      const { data: customer } = await supabase.from("erp_customers").select("total_visits, total_paid").eq("id", customer_id).single();
      if (customer) {
        await supabase
          .from("erp_customers")
          .update({
            total_visits: (customer.total_visits || 0) + 1,
            total_paid: Number(customer.total_paid || 0) + cumulativeTotal,
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

    // Find all siblings
    const { data: siblings, error: sibErr } = await supabase
      .from("erp_purchase_receipts")
      .select("*")
      .or(`receipt_number.eq.${baseReceiptNum},receipt_number.like.${baseReceiptNum}/%`);

    if (sibErr) throw sibErr;

    // 2. Revert stock and delete each old sibling
    const oldSiblings = siblings || [];
    let oldCumulativeTotal = 0;
    const oldCustId = oldReceipt.customer_id;

    for (const sib of oldSiblings) {
      oldCumulativeTotal += Number(sib.total_amount);

      // Revert stock
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

      // Delete old sibling
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

    // 3. Normalize new items to insert
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

    let newCumulativeTotal = 0;
    let firstNewReceipt: any = null;

    // 4. Insert new items under the same baseReceiptNum
    for (let i = 0; i < itemsToInsert.length; i++) {
      const item = itemsToInsert[i];

      // Verify new material
      const { data: material, error: mErr } = await supabase
        .from("erp_materials")
        .select("id, name, unit, stock_qty")
        .eq("id", item.material_id)
        .single();
      if (mErr || !material) return res.status(404).json({ success: false, message: `Material not found: ${item.material_id}` });

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
        created_by: req.privilegedUser?.id,
        updated_at: new Date().toISOString(),
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

      // Add weight to stock
      await supabase
        .from("erp_materials")
        .update({
          stock_qty: Number(material.stock_qty) + item.weight,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.material_id);

      if (i === 0) {
        firstNewReceipt = receipt;
      }
    }

    // 5. Update new customer stats
    const newCustId = customer_id || null;
    if (newCustId && newCumulativeTotal > 0) {
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
            updated_at: new Date().toISOString(),
          })
          .eq("id", newCustId);
      }
    }

    // 6. Fetch fully formatted receipt to return
    const { data: fullReceipt, error: getFullErr } = await supabase
      .from("erp_purchase_receipts")
      .select(`
        *,
        erp_customers(name, phone),
        erp_materials(name, unit)
      `)
      .eq("id", firstNewReceipt.id)
      .single();

    if (getFullErr) throw getFullErr;

    const formatted = {
      ...fullReceipt,
      customer_name: fullReceipt.erp_customers?.name || "Walk-in Customer",
      customer_phone: fullReceipt.erp_customers?.phone || "",
      material_name: fullReceipt.erp_materials?.name || "",
      material_unit: fullReceipt.erp_materials?.unit || "kg",
    };

    res.json({ success: true, receipt: formatted });
  } catch (err: any) {
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

    // 2. Reverse stock
    const { data: material } = await supabase.from("erp_materials").select("stock_qty").eq("id", r.material_id).single();
    if (material) {
      await supabase
        .from("erp_materials")
        .update({
          stock_qty: Math.max(0, Number(material.stock_qty) - Number(r.weight)),
          updated_at: new Date().toISOString(),
        })
        .eq("id", r.material_id);
    }

    // 3. Reverse customer stats
    if (r.customer_id) {
      const { data: customer } = await supabase.from("erp_customers").select("total_visits, total_paid").eq("id", r.customer_id).single();
      if (customer) {
        await supabase
          .from("erp_customers")
          .update({
            total_visits: Math.max(0, Number(customer.total_visits || 0) - 1),
            total_paid: Math.max(0, Number(customer.total_paid || 0) - Number(r.total_amount)),
            updated_at: new Date().toISOString(),
          })
          .eq("id", r.customer_id);
      }
    }

    // 4. Delete receipt record
    const { error: deleteErr } = await supabase.from("erp_purchase_receipts").delete().eq("id", req.params.id);
    if (deleteErr) throw deleteErr;

    res.json({ success: true, message: "Receipt deleted" });
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

// GET /api/erp/whatsapp/logs — List dispatch logs
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
erpRouter.get("/dashboard", async (req, res) => {
  try {
    // 1. Calculations: Total collected revenue & weights this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: txnsThisMonth, error: txnErr } = await supabase
      .from("erp_transactions")
      .select("total_amount, weight")
      .gte("created_at", startOfMonth.toISOString());

    if (txnErr) throw txnErr;

    const revenueThisMonth = (txnsThisMonth || []).reduce((sum, t) => sum + Number(t.total_amount), 0);
    const weightThisMonth = (txnsThisMonth || []).reduce((sum, t) => sum + Number(t.weight), 0);
    const txnsCountThisMonth = (txnsThisMonth || []).length;

    // 2. Low stock alerts (materials where stock_qty <= min_threshold)
    const { data: lowStock, error: stockErr } = await supabase
      .from("erp_materials")
      .select("id, name, stock_qty, min_threshold, color_hex, unit")
      .eq("is_active", true);

    if (stockErr) throw stockErr;

    const lowStockAlerts = (lowStock || [])
      .filter((m) => Number(m.stock_qty) <= Number(m.min_threshold))
      .sort((a, b) => {
        const thresholdA = Number(a.min_threshold) || 1;
        const thresholdB = Number(b.min_threshold) || 1;
        return (Number(a.stock_qty) / thresholdA) - (Number(b.stock_qty) / thresholdB);
      });

    // 3. Last 10 B2B transactions
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

    // 4. Invoices outstanding summary
    const { data: invoices, error: invErr } = await supabase.from("erp_invoices").select("status, amount");
    if (invErr) throw invErr;

    const invoice_summary = {
      pending_count: 0,
      overdue_count: 0,
      pending_amount: 0,
      overdue_amount: 0,
    };

    (invoices || []).forEach((inv) => {
      const amt = Number(inv.amount);
      if (inv.status === "pending") {
        invoice_summary.pending_count++;
        invoice_summary.pending_amount += amt;
      } else if (inv.status === "overdue") {
        invoice_summary.overdue_count++;
        invoice_summary.overdue_amount += amt;
      }
    });

    // 5. Monthly trend last 6 months (simulated using standard date aggregations)
    // To support clean queries, we fetch all transactions of last 6 months and group them by Month in JS.
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const { data: trendsData, error: trendErr } = await supabase
      .from("erp_transactions")
      .select("total_amount, created_at")
      .gte("created_at", sixMonthsAgo.toISOString());

    if (trendErr) throw trendErr;

    const monthsMap: Record<string, { total_revenue: number; transaction_count: number }> = {};
    const monthsOrder: string[] = [];

    // Initialize past 6 months in order
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const label = d.toLocaleDateString("en-US", { month: "short" });
      monthsMap[label] = { total_revenue: 0, transaction_count: 0 };
      monthsOrder.push(label);
    }

    (trendsData || []).forEach((t) => {
      const label = new Date(t.created_at).toLocaleDateString("en-US", { month: "short" });
      if (monthsMap[label]) {
        monthsMap[label].total_revenue += Number(t.total_amount);
        monthsMap[label].transaction_count++;
      }
    });

    const monthly_trend = monthsOrder.map((month) => ({
      month,
      total_revenue: monthsMap[month].total_revenue,
      transaction_count: monthsMap[month].transaction_count,
    }));

    // 6. Top 5 materials by revenue this month
    const { data: topMatsData, error: topMatsErr } = await supabase
      .from("erp_transactions")
      .select("total_amount, weight, erp_materials(name, color_hex)")
      .gte("created_at", startOfMonth.toISOString());

    if (topMatsErr) throw topMatsErr;

    const materialsRevenueMap: Record<string, { name: string; color_hex: string; revenue: number; weight_collected: number }> = {};
    (topMatsData || []).forEach((t: any) => {
      const name = t.erp_materials?.name;
      if (name) {
        if (!materialsRevenueMap[name]) {
          materialsRevenueMap[name] = {
            name,
            color_hex: t.erp_materials.color_hex || "#f5a623",
            revenue: 0,
            weight_collected: 0,
          };
        }
        materialsRevenueMap[name].revenue += Number(t.total_amount);
        materialsRevenueMap[name].weight_collected += Number(t.weight);
      }
    });

    const top_materials = Object.values(materialsRevenueMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    res.json({
      success: true,
      dashboard: {
        revenue: {
          revenue_this_month: revenueThisMonth,
          weight_this_month: weightThisMonth,
          txn_count_this_month: txnsCountThisMonth,
        },
        low_stock_alerts: lowStockAlerts,
        recent_transactions: formattedRecent,
        monthly_trend,
        top_materials,
        invoice_summary,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});
