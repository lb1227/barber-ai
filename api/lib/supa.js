import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
  process.exit(1);
}

export const supaAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
