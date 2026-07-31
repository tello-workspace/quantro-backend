import { NextRequest } from "next/server";
import { updateCustomFieldValueSchema } from "@/schemas/custom-field.schema";
import * as customFieldService from "@/services/custom-field.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { validateBody } from "@/middleware/validate";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; fieldId: string }> },
) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id, fieldId } = await params;
    const body = await validateBody(request, updateCustomFieldValueSchema);
    if (body instanceof Response) return body;

    const value = await customFieldService.setCardCustomFieldValue(id, fieldId, body, user.id);
    return successResponse(value);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Ek alan değeri kaydedilemedi");
  }
}
