import { NextRequest } from "next/server";
import * as avatarService from "@/services/avatar.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return errorResponse("file alanı gerekli", 400, "VALIDATION_ERROR");
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const updated = await avatarService.uploadAvatar(user.id, {
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      buffer,
    });

    return successResponse(updated, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Profil fotoğrafı yüklenemedi");
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const updated = await avatarService.removeAvatar(user.id);
    return successResponse(updated);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Profil fotoğrafı kaldırılamadı");
  }
}
