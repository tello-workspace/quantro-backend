import { NextRequest } from "next/server";
import { registerSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { checkRateLimit } from "@/middleware/rateLimit";
import { checkIdempotency, clearIdempotency, failIdempotency } from "@/middleware/idempotency";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "register");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, registerSchema);
    if (body instanceof Response) return body;

    // Register'da userId yok, email'i kullan
    const idem = checkIdempotency(request, body.email || "unknown", body);
    if (idem instanceof Response) return idem;

    try {
      const result = await authService.register(body);
      clearIdempotency(idem.key);
      return successResponse(result, 201);
    } catch (err) {
      failIdempotency(idem.key);
      throw err;
    }
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse(error instanceof Error ? error.message : String(error), 500, "INTERNAL_ERROR");
  }
}
