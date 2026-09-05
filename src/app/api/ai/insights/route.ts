import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkAiRateLimit } from "@/middleware/rateLimit";
import { checkProjectAccess } from "@/services/access-control.service";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;

    const rateLimitError = checkAiRateLimit(user.id, "ai:insights");
    if (rateLimitError) return rateLimitError;

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return errorResponse("projectId parametresi gerekli", 400, "VALIDATION_ERROR");
    }

    // Kullanıcının projeye erişimi var mı kontrol et: bkz. ai/chat/route.ts'teki
    // aynı not - ham org üyeliği yeterli değil, GUEST/PRIVATE/TEAM görünürlüğü
    // de uygulanmalı.
    await checkProjectAccess(projectId, user.id);

    const insights = await aiService.generateProjectInsights(projectId, user.id);
    return successResponse({ insights });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "İçgörüler alınamadı");
  }
}
