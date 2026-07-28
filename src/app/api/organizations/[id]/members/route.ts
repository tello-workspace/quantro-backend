import { NextRequest } from "next/server";
import { addMemberSchema, updateMemberRoleSchema } from "@/schemas/organization.schema";
import * as organizationService from "@/services/organization.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, addMemberSchema);
    if (body instanceof Response) return body;

    const invitation = await organizationService.inviteMember(id, body, user.id);
    return successResponse(invitation, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Davet gönderilemedi");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const { searchParams } = new URL(request.url);
    const memberUserId = searchParams.get("userId");

    if (!memberUserId) {
      return errorResponse("userId parametresi gerekli", 400, "VALIDATION_ERROR");
    }

    await organizationService.removeMember(id, memberUserId, user.id);
    return successResponse({ removed: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Üye çıkarılamadı");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, updateMemberRoleSchema);
    if (body instanceof Response) return body;

    const member = await organizationService.updateMemberRole(id, body, user.id);
    return successResponse(member);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Rol güncellenemedi");
  }
}
