import { NextRequest } from "next/server";
import { createDependencySchema } from "@/schemas/dependency.schema";
import * as dependencyService from "@/services/dependency.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, createDependencySchema);
    if (body instanceof Response) return body;

    const dependency = await dependencyService.addDependency(id, body.blockerId, user.id);
    return successResponse(dependency, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return errorResponse("Bağımlılık eklenemedi", 500, "INTERNAL_ERROR");
  }
}
