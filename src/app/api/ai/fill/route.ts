import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkAiRateLimit } from "@/middleware/rateLimit";
import { checkProjectAccess } from "@/services/access-control.service";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;

    const rateLimitError = checkAiRateLimit(user.id, "ai:fill");
    if (rateLimitError) return rateLimitError;

    const body = await request.json();
    const { projectId, title } = body;

    if (!projectId || !title) {
      return errorResponse("projectId ve title gerekli", 400, "VALIDATION_ERROR");
    }

    // Projeye erişim kontrolü: bkz. ai/chat/route.ts'teki aynı not - ham org
    // üyeliği yeterli değil, GUEST/PRIVATE/TEAM görünürlüğü de uygulanmalı.
    await checkProjectAccess(projectId, user.id);

    const data = await aiService.generateCardDetails(projectId, user.id, title);
    return successResponse(data);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "AI detayları üretilemedi");
  }
}
