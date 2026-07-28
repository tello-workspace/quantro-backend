import { createClient } from "@supabase/supabase-js";

// SADECE SUNUCU TARAFI: service role key RLS'i bypass eder, asla frontend'e
// veya loglara sizmamali. Kart eklerini private bir bucket'a yazmak/okumak
// icin kullanilir; yetki kontrolu Supabase RLS'e degil, bizim kendi
// checkCardAccess() fonksiyonumuza dayanir.
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAdmin =
  url && serviceRoleKey
    ? createClient(url, serviceRoleKey, { auth: { persistSession: false } })
    : null;

export const ATTACHMENTS_BUCKET = "card-attachments";
