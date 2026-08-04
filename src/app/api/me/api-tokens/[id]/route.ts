import { NextRequest } from "next/server";
import * as apiTokenService from "@/services/api-token.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Iptal, kaydi SILMEK yerine revokedAt isaretliyor: kullanici "bu anahtari
// ne zaman iptal etmistim" sorusunu cevaplayabilsin ve iptal edilmis bir
// anahtarin hash'i yeniden uretilemesin.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    await apiTokenService.revokeApiToken(user.id, id);
    return successResponse({ id, revoked: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "API anahtarı iptal edilemedi");
  }
}
