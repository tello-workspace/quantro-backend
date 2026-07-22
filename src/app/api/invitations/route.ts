import { NextRequest } from "next/server";
import * as organizationService from "@/services/organization.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// Bekleyen davetlerim
export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const invitations = await organizationService.getMyInvitations(user.id);
    return successResponse(invitations);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Davetler alınamadı", 500, "INTERNAL_ERROR");
  }
}
