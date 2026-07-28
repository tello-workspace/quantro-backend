import { NextRequest } from "next/server";
import * as notificationService from "@/services/notification.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";
import { getNotificationsQuerySchema } from "@/schemas/notification.schema";

export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;

    const { searchParams } = new URL(request.url);
    const query = getNotificationsQuerySchema.parse({
      unreadOnly: searchParams.get("unreadOnly") ?? undefined,
    });

    const notifications = await notificationService.getNotifications(
      user.id,
      query.unreadOnly,
    );

    return successResponse(notifications);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Bildirimler alınamadı");
  }
}

