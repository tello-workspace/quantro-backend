import { NextRequest } from "next/server";
import { createBadgeSchema, assignBadgeSchema } from "@/schemas/organization.schema";
import * as badgeService from "@/services/badge.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const badges = await badgeService.listBadges(id, user.id);
    return successResponse(badges);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Rozetler yüklenemedi");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, createBadgeSchema);
    if (body instanceof Response) return body;

    const badge = await badgeService.createBadge(id, body, user.id);
    return successResponse(badge, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Rozet oluşturulamadı");
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
    if (!badgeId) return errorResponse("badgeId parametresi gerekli", 400, "VALIDATION_ERROR");

    await badgeService.deleteBadge(id, badgeId, user.id);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Rozet silinemedi");
  }
}
