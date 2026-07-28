import { NextRequest } from "next/server";
import * as authService from "@/services/auth.service";
import { updateProfileSchema } from "@/schemas/auth.schema";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest) {
  const authResponse = await authenticate(request);
  if (authResponse) return authResponse;

  const user = (request as AuthenticatedRequest).user;

  try {
    const result = await authService.getMe(user.id);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Kullanıcı bilgisi alınamadı", 500, "INTERNAL_ERROR");
  }
}

export async function PATCH(request: NextRequest) {
  const authResponse = await authenticate(request);
  if (authResponse) return authResponse;

  const user = (request as AuthenticatedRequest).user;

  try {
    const body = await validateBody(request, updateProfileSchema);
    if (body instanceof Response) return body;

    const result = await authService.updateProfile(user.id, body);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Profil güncellenemedi", 500, "INTERNAL_ERROR");
  }
}
