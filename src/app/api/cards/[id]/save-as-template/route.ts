import { NextRequest } from "next/server";
import { createTemplateFromCardSchema } from "@/schemas/template.schema";
import * as templateService from "@/services/template.service";
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
    const body = await validateBody(request, createTemplateFromCardSchema);
    if (body instanceof Response) return body;

    const template = await templateService.createTemplateFromCard(id, body.name, user.id);
    return successResponse(template, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Kart şablon olarak kaydedilemedi");
  }
}
