import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkAiRateLimit } from "@/middleware/rateLimit";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const authResponse = await authenticate(request);
  if (authResponse) return authResponse;

  try {
    const user = (request as AuthenticatedRequest).user;

    const rateLimitError = checkAiRateLimit(user.id, "ai:analyze-push");
    if (rateLimitError) return rateLimitError;

    const body = await request.json();
    const { commitMessage, diff } = body;

    if (commitMessage === undefined || diff === undefined) {
      return errorResponse("commitMessage ve diff gereklidir", 400, "VALIDATION_ERROR");
    }

    const result = await aiService.analyzePushAndMoveCards(user.id, commitMessage, diff);
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Push analizi sırasında hata oluştu");
  }
}
