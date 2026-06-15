import type { NextFunction, Request, Response } from "express";
import { supabase } from "../lib/supabase.js";

export interface AdminUser {
  id: string;
  email: string;
  role: string;
}

// Extend Express Request to include admin user
declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.split(" ")[1];

  // Verify JWT with Supabase
  const { data: userData, error: authError } =
    await supabase.auth.getUser(token);

  if (authError || !userData.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Check profile role
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, email, role")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    res.status(403).json({ error: "Profile not found" });
    return;
  }

  if (profile.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  req.adminUser = profile as AdminUser;
  next();
}
