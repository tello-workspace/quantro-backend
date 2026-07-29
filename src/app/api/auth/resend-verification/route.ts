import { NextRequest } from "next/server";
import { resendVerificationSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { checkRateLimit } from "@/middleware/rateLimit";

// Kullanicinin var olup olmadigini veya zaten dogrulanmis oldugunu sizdirmamak
// icin gecerli/gecersiz email farketmeksizin ayni basarili yaniti doner
// (forgot-password ile ayni desen).
export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "resend-verification");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, resendVerificationSchema);
    if (body instanceof Response) return body;

    await authService.resendVerification(body);

    return successResponse({
      message: "Bu email adresi kayıtlıysa ve henüz doğrulanmadıysa yeni bir doğrulama bağlantısı gönderildi",
    });
  } catch (error) {
    return handleApiError(request, error, "İstek işlenemedi");
  }
}
