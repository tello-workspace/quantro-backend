import { NextRequest } from "next/server";
import { updateVisibilitySchema } from "@/schemas/project.schema";
import * as projectService from "@/services/project.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; projectId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { projectId } = await params;
    const body = await validateBody(request, updateVisibilitySchema);
    if (body instanceof Response) return body;

    const project = await projectService.updateProjectVisibility(projectId, body.visibility, user.id);
    return successResponse(project);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Proje görünürlüğü güncellenemedi");
  }
}
