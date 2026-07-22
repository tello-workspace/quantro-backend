import { NextRequest } from "next/server";
import { loginSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { checkRateLimit } from "@/middleware/rateLimit";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "login");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, loginSchema);
    if (body instanceof Response) return body;

    const result = await authService.login(body);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Giriş başarısız", 500, "INTERNAL_ERROR");
  }
}
