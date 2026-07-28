import { NextRequest } from "next/server";
import * as notificationService from "@/services/notification.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const notification = await notificationService.markAsRead(id, user.id);
    return successResponse(notification);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Bildirim okunamadı");
  }
}
