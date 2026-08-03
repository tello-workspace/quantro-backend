import { NextRequest } from "next/server";
import { updateProjectSchema } from "@/schemas/project.schema";
import * as projectService from "@/services/project.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; projectId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id, projectId } = await params;
    const project = await projectService.getProjectById(id, projectId, user.id);
    return successResponse(project);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Proje alınamadı");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; projectId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id, projectId } = await params;
    const body = await validateBody(request, updateProjectSchema);
    if (body instanceof Response) return body;

    const project = await projectService.updateProject(id, projectId, body, user.id);
    return successResponse(project);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Proje güncellenemedi");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; projectId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id, projectId } = await params;
    await projectService.deleteProject(id, projectId, user.id);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Proje silinemedi");
  }
}
