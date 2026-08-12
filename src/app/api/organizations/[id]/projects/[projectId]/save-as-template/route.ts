import { NextRequest } from "next/server";
import { saveAsTemplateSchema } from "@/schemas/project.schema";
import * as projectTemplateService from "@/services/project-template.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; projectId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { projectId } = await params;
    const body = await validateBody(request, saveAsTemplateSchema);
    if (body instanceof Response) return body;

    const template = await projectTemplateService.createProjectTemplateFromProject(projectId, body.name, user.id);
    return successResponse(template, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Şablon oluşturulamadı");
  }
}
