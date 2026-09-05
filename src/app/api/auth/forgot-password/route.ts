import { NextRequest } from "next/server";
import { forgotPasswordSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import {
  checkRateLimit,
  checkAccountRateLimit,
  recordAccountFailure,
} from "@/middleware/rateLimit";

// Kullanicinin var olup olmadigini sizdirmamak icin gecerli/gecersiz email
// farketmeksizin ayni basarili yaniti doner.
export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "forgot-password");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, forgotPasswordSchema);
    if (body instanceof Response) return body;

    // MAIL BOMBARDIMANI: checkRateLimit kovasi `${key}:${ip}` oldugu icin sinir
    // yalnizca GONDEREN IP basinaydi; saldirgan IP degistirerek ayni kutuya
    // sinirsiz sifirlama maili yollayabiliyor, her istekte yeni bir
    // PasswordResetToken birikiyordu. Hedef e-posta basina ikinci bir kova
    // sayiyoruz (login'in hesap kovasiyla ayni altyapi, ayri anahtar).
    // Sinir asilinca 429 DEGIL, ayni basarili yaniti donuyoruz: 429 ile 200
    // ayrimi "bu adres icin mail uretiliyor mu" sorusuna gozlemlenebilir bir
    // cevap verir ve dosyanin en ustundeki numaralandirma korumasini delerdi.
    const hedefKovaDolu = checkAccountRateLimit("forgot-password", body.email);
    if (!hedefKovaDolu) {
      recordAccountFailure("forgot-password", body.email);
      await authService.requestPasswordReset(body);
    }

    return successResponse({
      message: "Bu email adresi kayıtlıysa şifre sıfırlama bağlantısı gönderildi",
    });
  } catch (error) {
    return handleApiError(request, error, "İstek işlenemedi");
  }
}
