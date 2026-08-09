import { NextRequest } from "next/server";
import * as documentService from "@/services/project-document.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// quantro-mcp'nin read_document araci bu uctan besleniyor: belgenin
// yeniden yuklenmesine gerek kalmadan onceden cikarilmis duz metnini doner.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id, documentId } = await params;

    const result = await documentService.getDocumentText(id, documentId, user.id);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Belge metni alınamadı");
  }
}
