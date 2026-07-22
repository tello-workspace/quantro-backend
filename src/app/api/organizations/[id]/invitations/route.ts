import { NextRequest } from "next/server";
import * as organizationService from "@/services/organization.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// GET /api/organizations/:id/invitations - organizasyonun bekleyen davetleri (admin)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const invitations = await organizationService.getPendingInvitations(id, user.id);
    return successResponse(invitations);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Davetler alınamadı", 500, "INTERNAL_ERROR");
  }
}

// DELETE /api/organizations/:id/invitations?invitationId=... - bekleyen daveti geri al (admin)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const { searchParams } = new URL(request.url);
    const invitationId = searchParams.get("invitationId");

    if (!invitationId) {
      return errorResponse("invitationId parametresi gerekli", 400, "VALIDATION_ERROR");
    }

    await organizationService.cancelInvitation(id, invitationId, user.id);
    return successResponse({ cancelled: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Davet geri alınamadı", 500, "INTERNAL_ERROR");
  }
}
