import { NextRequest } from "next/server";
import { createChecklistItemSchema } from "@/schemas/checklist.schema";
import * as checklistService from "@/services/checklist.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const items = await checklistService.getChecklistItems(id, user.id);
    return successResponse(items);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Checklist alınamadı");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const body = await validateBody(request, createChecklistItemSchema);
    if (body instanceof Response) return body;

    const item = await checklistService.createChecklistItem(id, body, user.id);
    return successResponse(item, 201);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Checklist maddesi eklenemedi");
  }
}
