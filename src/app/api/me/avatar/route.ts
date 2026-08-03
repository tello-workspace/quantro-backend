import { NextRequest } from "next/server";
import * as avatarService from "@/services/avatar.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // avatar.service ile ayni (5MB)

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

    // Buffer'a almadan once boyut reddi: devasa bir gorseli sadece reddetmek
    // icin bile bellekte tutmak gereksiz. (Servis kontrolu backstop olarak kalir.)
    if (file.size > MAX_FILE_SIZE) {
      return errorResponse("Görsel en fazla 5MB olabilir", 400, "FILE_TOO_LARGE");
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

// Hazir avatar secimi. Yukleme (POST) ile ayni kaynagi hedefledigi icin ayni
// route'ta duruyor; farki dosya degil, beyaz listedeki bir isim almasi.
export async function PUT(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const body = await request.json().catch(() => null);
    const preset = (body as { preset?: unknown } | null)?.preset;

    if (typeof preset !== "string") {
      return errorResponse("preset alanı gerekli", 400, "VALIDATION_ERROR");
    }

    const updated = await avatarService.setPresetAvatar(user.id, preset);
    return successResponse(updated);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Avatar seçilemedi");
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
