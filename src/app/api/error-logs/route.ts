import { NextRequest } from "next/server";
import * as errorLogService from "@/services/error-log.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// GET /api/error-logs - herhangi bir organizasyonda ADMIN olan kullanici
// en son beklenmeyen (500) hatalari gorebilir.
export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") ?? "50", 10);

    const logs = await errorLogService.listErrorLogs(user.id, limit);
    return successResponse(logs);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Hata kayıtları alınamadı");
  }
}
