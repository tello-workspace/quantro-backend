import { NextRequest } from "next/server";
import { registerSchema } from "@/schemas/auth.schema";
import * as authService from "@/services/auth.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { checkRateLimit } from "@/middleware/rateLimit";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const rateLimitError = checkRateLimit(request, "register");
  if (rateLimitError) return rateLimitError;

  try {
    const body = await validateBody(request, registerSchema);
    if (body instanceof Response) return body;

    const result = await authService.register(body);
    return successResponse(result, 201);
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse(error instanceof Error ? error.message : String(error), 500, "INTERNAL_ERROR");
  }
}
