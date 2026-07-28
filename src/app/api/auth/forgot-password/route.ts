import { NextRequest } from "next/server";
import { forgotPasswordSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { checkRateLimit } from "@/middleware/rateLimit";

// Kullanicinin var olup olmadigini sizdirmamak icin gecerli/gecersiz email
// farketmeksizin ayni basarili yaniti doner.
export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "forgot-password");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, forgotPasswordSchema);
    if (body instanceof Response) return body;

    await authService.requestPasswordReset(body);

    return successResponse({
      message: "Bu email adresi kayıtlıysa şifre sıfırlama bağlantısı gönderildi",
    });
  } catch (error) {
    return handleApiError(request, error, "İstek işlenemedi");
  }
}
