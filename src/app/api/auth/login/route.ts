import { NextRequest } from "next/server";
import { loginSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import {
  checkRateLimit,
  checkAccountRateLimit,
  recordAccountFailure,
  clearAccountFailures,
} from "@/middleware/rateLimit";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "login");
  if (rateLimitError) return rateLimitError;

  let email: string | null = null;

  try {
    const body = await validateBody(request, loginSchema);
    if (body instanceof Response) return body;

    // IP sayaci tek basina yetmiyor (IP havuzu ile baypas edilebiliyor);
    // hedef hesabin kendi basarisiz deneme kovasini da kontrol ediyoruz.
    email = body.email;
    const accountLimitError = checkAccountRateLimit("login", email);
    if (accountLimitError) return accountLimitError;

    const result = await authService.login(body);
    clearAccountFailures("login", email);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      // Yalnizca kimlik dogrulama basarisizliklari sayaci besler; "email
      // dogrulanmadi" gibi parola dogruyken donen hatalar hesabi kilitlemesin.
      if (email && error.statusCode === 401) {
        recordAccountFailure("login", email);
      }
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Giriş başarısız");
  }
}
