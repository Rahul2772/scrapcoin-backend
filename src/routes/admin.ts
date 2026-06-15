import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { supabase } from "../lib/supabase.js";

export const adminRouter = Router();

// All admin routes require admin auth
adminRouter.use(requireAdmin);

// GET /api/admin/users — list all users with roles
adminRouter.get("/users", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role, created_at")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// PATCH /api/admin/users/:id — update user role
adminRouter.patch("/users/:id", async (req, res) => {
  const parsed = z
    .object({ role: z.enum(["admin", "user"]) })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid role value" });
  }

  // Prevent admin from changing their own role
  if (req.adminUser?.id === req.params.id) {
    return res.status(403).json({ error: "You cannot change your own role" });
  }

  try {
    const { data, error } = await supabase
      .from("profiles")
      .update({ role: parsed.data.role })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Failed to update user role" });
  }
});

// POST /api/admin/invite — invite a new admin by email
adminRouter.post("/invite", async (req, res) => {
  const parsed = z
    .object({ email: z.string().email() })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  try {
    const { error } = await supabase.auth.admin.inviteUserByEmail(
      parsed.data.email
    );
    if (error) throw new Error(error.message);
    return res.json({ message: `Invite sent to ${parsed.data.email}` });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to send invite",
    });
  }
});
