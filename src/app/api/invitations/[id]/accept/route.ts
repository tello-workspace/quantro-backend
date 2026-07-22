import { NextRequest } from "next/server";
import * as organizationService from "@/services/organization.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const member = await organizationService.acceptInvitation(id, user.id);
    return successResponse(member);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Davet kabul edilemedi", 500, "INTERNAL_ERROR");
  }
}
