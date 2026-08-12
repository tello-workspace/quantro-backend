import { NextRequest } from "next/server";
import { previewImportSchema } from "@/schemas/import.schema";
import * as importService from "@/services/import.service";
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
    const body = await validateBody(request, previewImportSchema);
    if (body instanceof Response) return body;

    const preview = await importService.previewImport(id, body.format, body.fileContent, user.id);
    return successResponse(preview);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "İçe aktarma önizlemesi oluşturulamadı");
  }
}
