import { NextRequest } from "next/server";
import * as notificationService from "@/services/notification.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";
import { z } from "zod";
import { NotificationType } from "@prisma/client";

const setPrefSchema = z.object({
  type: z.enum(Object.values(NotificationType) as [string, ...string[]]),
  enabled: z.boolean(),
});

export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const prefs = await notificationService.getNotificationPrefs(user.id);
    return successResponse(prefs);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Bildirim tercihleri alınamadı");
  }
}

export async function PATCH(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const body = await request.json();
    const parsed = setPrefSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse("Geçersiz tercih verisi", 400, "VALIDATION_ERROR");
    }

    const result = await notificationService.setNotificationPref(
      user.id,
      parsed.data.type as NotificationType,
      parsed.data.enabled,
    );
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Bildirim tercihi güncellenemedi");
  }
}
