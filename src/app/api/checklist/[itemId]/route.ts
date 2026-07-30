import { NextRequest } from "next/server";
import { updateChecklistItemSchema } from "@/schemas/checklist.schema";
import * as checklistService from "@/services/checklist.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { itemId } = await params;
    const body = await validateBody(request, updateChecklistItemSchema);
    if (body instanceof Response) return body;

    const item = await checklistService.updateChecklistItem(itemId, body, user.id);
    return successResponse(item);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Checklist maddesi güncellenemedi");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { itemId } = await params;
    await checklistService.deleteChecklistItem(itemId, user.id);
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Checklist maddesi silinemedi");
  }
}
