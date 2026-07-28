import { NextRequest } from "next/server";
import { resetPasswordSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { checkRateLimit } from "@/middleware/rateLimit";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "reset-password");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, resetPasswordSchema);
    if (body instanceof Response) return body;

    await authService.resetPassword(body);

    return successResponse({ message: "Şifreniz güncellendi" });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Şifre sıfırlanamadı");
  }
}
