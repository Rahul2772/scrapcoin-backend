import { Router } from "express";
import { requireAdminOrChampion } from "../middleware/requireAdminOrChampion.js";
import { supabase } from "../lib/supabase.js";

export const notificationsRouter = Router();

// GET /api/notifications — List notifications
notificationsRouter.get("/", requireAdminOrChampion, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("erp_notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      // 42P01 is PostgreSQL code for "relation does not exist"
      if (error.code === "42P01") {
        console.warn("[ERP Notifications] Table 'erp_notifications' does not exist in Supabase yet. Please execute the SQL migration script.");
        return res.json([]);
      }
      throw error;
    }

    return res.json(data || []);
  } catch (err: any) {
    console.error("GET /api/notifications error:", err);
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// POST /api/notifications/mark-all-read — Mark all notifications as read
notificationsRouter.post("/mark-all-read", requireAdminOrChampion, async (req, res) => {
  try {
    const { error } = await supabase
      .from("erp_notifications")
      .update({ is_read: true })
      .eq("is_read", false);

    if (error) {
      if (error.code === "42P01") {
        console.warn("[ERP Notifications] Table 'erp_notifications' does not exist in Supabase yet.");
        return res.json({ success: true, message: "No notifications to mark read" });
      }
      throw error;
    }

    return res.json({ success: true, message: "All notifications marked as read" });
  } catch (err: any) {
    console.error("POST /api/notifications/mark-all-read error:", err);
    return res.status(500).json({ error: "Failed to mark notifications as read" });
  }
});

// DELETE /api/notifications — Clear all notifications
notificationsRouter.delete("/", requireAdminOrChampion, async (req, res) => {
  try {
    const { error } = await supabase
      .from("erp_notifications")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000"); // deletes all

    if (error) {
      if (error.code === "42P01") {
        return res.json({ success: true });
      }
      throw error;
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error("DELETE /api/notifications error:", err);
    return res.status(500).json({ error: "Failed to clear notifications" });
  }
});
