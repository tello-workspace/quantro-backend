import { NextRequest } from "next/server";
import * as documentService from "@/services/project-document.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";
import { MAX_FILE_SIZE } from "@/lib/document-policy";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;

    const documents = await documentService.listDocuments(id, user.id);
    return successResponse(documents);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Belgeler alınamadı");
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
      return errorResponse("Dosya en fazla 20MB olabilir", 400, "FILE_TOO_LARGE");
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const document = await documentService.uploadDocument(id, user.id, {
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      buffer,
    });

    return successResponse(document, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Belge yüklenemedi");
  }
}
