import type { NextFunction, Request, Response } from "express";
import { supabase } from "../lib/supabase.js";

export interface PrivilegedUser {
  id: string;
  email: string;
  role: string;
}

// Extend Express Request to include privileged user
declare global {
  namespace Express {
    interface Request {
      privilegedUser?: PrivilegedUser;
    }
  }
}

export async function requireAdminOrChampion(
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

  if (profile.role !== "admin" && profile.role !== "champion") {
    res.status(403).json({ error: "Admin or Champion access required" });
    return;
  }

  req.privilegedUser = profile as PrivilegedUser;
  next();
}
