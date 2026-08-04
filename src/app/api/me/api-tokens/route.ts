import { NextRequest } from "next/server";
import * as apiTokenService from "@/services/api-token.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1, "Anahtar adı zorunludur").max(100),
});

export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    return successResponse(await apiTokenService.listApiTokens(user.id));
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "API anahtarları alınamadı");
  }
}

export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ?? "Geçersiz veri",
        400,
        "VALIDATION_ERROR",
      );
    }

    // Yanittaki "token" alani ham anahtari iceriyor ve BIR DAHA
    // dondurulemez - listeleme ucunda yalnizca on ek gorunur.
    const olusan = await apiTokenService.createApiToken(user.id, parsed.data.name);
    return successResponse(olusan, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "API anahtarı oluşturulamadı");
  }
}
