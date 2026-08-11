import { NextRequest } from "next/server";
import * as projectService from "@/services/project.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; projectId: string; userId: string }> },
) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { projectId, userId } = await params;
    await projectService.removeProjectMember(projectId, userId, user.id);
    return successResponse({ removed: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Proje üyesi çıkarılamadı");
  }
}
