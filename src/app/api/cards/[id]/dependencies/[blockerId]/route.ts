import { NextRequest } from "next/server";
import * as dependencyService from "@/services/dependency.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; blockerId: string }> },
) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id, blockerId } = await params;
    await dependencyService.removeDependency(id, blockerId, user.id);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Bağımlılık kaldırılamadı", 500, "INTERNAL_ERROR");
  }
}
