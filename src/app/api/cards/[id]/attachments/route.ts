import { NextRequest } from "next/server";
import * as attachmentService from "@/services/card-attachment.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";
import { MAX_FILE_SIZE } from "@/lib/attachment-policy";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const attachments = await attachmentService.listAttachments(id, user.id);
    return successResponse(attachments);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Ekler alınamadı");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return errorResponse("file alanı gerekli", 400, "VALIDATION_ERROR");
    }

    // Buffer'a almadan once boyut reddi: devasa bir dosyayi sadece reddetmek
    // icin bile bellekte tutmak gereksiz. (Servis kontrolu backstop olarak kalir.)
    if (file.size > MAX_FILE_SIZE) {
      return errorResponse("Dosya en fazla 10MB olabilir", 400, "FILE_TOO_LARGE");
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const attachment = await attachmentService.uploadAttachment(id, user.id, {
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      buffer,
    });

    return successResponse(attachment, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Dosya yüklenemedi");
  }
}
