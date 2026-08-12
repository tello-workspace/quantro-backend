import { NextRequest } from "next/server";
import * as projectTemplateService from "@/services/project-template.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; templateId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { templateId } = await params;
    await projectTemplateService.deleteProjectTemplate(templateId, user.id);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Şablon silinemedi");
  }
}
