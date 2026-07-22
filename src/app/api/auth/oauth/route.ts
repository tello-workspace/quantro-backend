import { NextRequest } from "next/server";
import * as authService from "@/services/auth.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { checkRateLimit } from "@/middleware/rateLimit";
import { AppError } from "@/utils/errors";

interface SupabaseUserResponse {
  email?: string;
  user_metadata?: { name?: string; full_name?: string };
}

// POST /api/auth/oauth - Supabase Auth (Google vb.) ile giris yapmis bir
// kullanicinin access token'ini dogrular, kendi User tablomuzda karsiligini
// bulur/olusturur ve kendi JWT'imizi doner. Boylece mevcut authenticate
// middleware'i ve rol bazli yetkilendirme degismeden calismaya devam eder.
export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "oauth");
  if (rateLimitError) return rateLimitError;

  try {
    const { accessToken } = await request.json();
    if (!accessToken || typeof accessToken !== "string") {
      return errorResponse("accessToken zorunludur", 400, "VALIDATION_ERROR");
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return errorResponse("Supabase yapilandirmasi eksik", 500, "CONFIG_ERROR");
    }

    const verifyRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
    });

    if (!verifyRes.ok) {
      return errorResponse("Gecersiz oturum", 401, "UNAUTHORIZED");
    }

    const supabaseUser = (await verifyRes.json()) as SupabaseUserResponse;
    if (!supabaseUser.email) {
      return errorResponse("Saglayicidan email alinamadi", 400, "OAUTH_ERROR");
    }

    const name =
      supabaseUser.user_metadata?.full_name ||
      supabaseUser.user_metadata?.name ||
      supabaseUser.email.split("@")[0];

    const result = await authService.oauthLogin(supabaseUser.email, name);
    return successResponse(result);
  } catch (error) {
    console.error("OAUTH LOGIN ERROR:", error);
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Giris yapilamadi", 500, "INTERNAL_ERROR");
  }
}
