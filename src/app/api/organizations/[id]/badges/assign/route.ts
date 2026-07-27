import { NextRequest } from "next/server";
import { assignBadgeSchema } from "@/schemas/organization.schema";
import * as badgeService from "@/services/badge.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, assignBadgeSchema);
    if (body instanceof Response) return body;

    const result = await badgeService.assignBadge(id, body.badgeId, body.userId, user.id);
    return successResponse(result, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Rozet atanamadı", 500, "INTERNAL_ERROR");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const badgeId = searchParams.get("badgeId");
    const targetUserId = searchParams.get("userId");

    if (!badgeId || !targetUserId) {
      return errorResponse("badgeId ve userId parametreleri gerekli", 400, "VALIDATION_ERROR");
    }

    await badgeService.removeBadge(id, badgeId, targetUserId, user.id);
    return successResponse({ removed: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Rozet kaldırılamadı", 500, "INTERNAL_ERROR");
  }
}
