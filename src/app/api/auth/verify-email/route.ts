import { NextRequest } from "next/server";
import { verifyEmailSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { checkRateLimit } from "@/middleware/rateLimit";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "verify-email");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, verifyEmailSchema);
    if (body instanceof Response) return body;

    await authService.verifyEmail(body);

    return successResponse({ message: "Email adresiniz doğrulandı" });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Email doğrulanamadı");
  }
}
