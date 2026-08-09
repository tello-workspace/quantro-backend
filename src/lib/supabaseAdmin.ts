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

// SUPABASE_SERVICE_ROLE_KEY'e yanlislikla anon/publishable anahtar konuldugunda
// Supabase Storage "new row violates row-level security policy" donuyor. Bu
// mesaj sorunun env degiskeninde oldugunu hicbir sekilde ele vermiyor, cunku
// gercek sebep RLS policy eksikligi degil: service_role RLS'i tamamen bypass
// eder, yani dogru anahtarla policy olmasa bile yazma calisir. Anahtarin
// rolunu onceden tespit edip hatayi anlasilir hale getiriyoruz.
function detectKeyRole(key: string): "service_role" | "public" | "unknown" {
  // Yeni format (2025+): sb_secret_... / sb_publishable_...
  if (key.startsWith("sb_secret_")) return "service_role";
  if (key.startsWith("sb_publishable_")) return "public";

  // Eski format: rolu payload'inda tasiyan imzali JWT.
  const parts = key.split(".");
  if (parts.length !== 3) return "unknown";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.role === "service_role") return "service_role";
    if (typeof payload.role === "string") return "public";
  } catch {
    // JWT degil - asagida "unknown" doner.
  }
  return "unknown";
}

export const SUPABASE_KEY_ROLE = serviceRoleKey ? detectKeyRole(serviceRoleKey) : "unknown";

if (serviceRoleKey && SUPABASE_KEY_ROLE === "public") {
  console.error(
    "[supabase] SUPABASE_SERVICE_ROLE_KEY bir service_role anahtari degil " +
      "(anon/publishable anahtar girilmis gorunuyor). Storage yuklemeleri RLS " +
      "hatasiyla basarisiz olacak. Supabase > Project Settings > API Keys " +
      "bolumunden service_role / secret anahtari kullanin.",
  );
}

// Storage yazma hatalarina eklenecek aciklama. Anahtar dogruysa null doner ve
// kullaniciya sadece Supabase'in kendi mesaji gosterilir.
export function storageKeyHint(): string {
  return SUPABASE_KEY_ROLE === "public"
    ? " (sunucudaki SUPABASE_SERVICE_ROLE_KEY service_role anahtari degil)"
    : "";
}

export const ATTACHMENTS_BUCKET = "card-attachments";
// Kart eklerinden farkli olarak PUBLIC bir bucket: profil fotograflari zaten
// herkese acik gosterilecegi icin imzali URL uretmeye gerek yok, dogrudan
// getPublicUrl() kullanilir.
export const AVATARS_BUCKET = "avatars";
// Projeye baglanan referans belgeleri (sartname, PRD vb.) — card-attachments
// gibi private, indirme signed URL uzerinden yapilir.
export const PROJECT_DOCUMENTS_BUCKET = "project-documents";
