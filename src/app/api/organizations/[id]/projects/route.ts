import { NextRequest } from "next/server";
import { createProjectSchema } from "@/schemas/project.schema";
import * as projectService from "@/services/project.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkIdempotency, clearIdempotency, failIdempotency } from "@/middleware/idempotency";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const projects = await projectService.getProjects(id, user.id);
    return successResponse(projects);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Projeler alınamadı", 500, "INTERNAL_ERROR");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, createProjectSchema);
    if (body instanceof Response) return body;

    // Idempotency check — aynı anda duplicate istek gelirse 409
    const idem = checkIdempotency(request, user.id, body);
    if (idem instanceof Response) return idem;

    try {
      const project = await projectService.createProject(id, body, user.id);
      clearIdempotency(idem.key);
      return successResponse(project, 201);
    } catch (err) {
      failIdempotency(idem.key);
      throw err;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Proje oluşturulamadı", 500, "INTERNAL_ERROR");
  }
}
