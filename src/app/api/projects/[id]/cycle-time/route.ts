import { NextRequest } from "next/server";
import * as insightService from "@/services/insight.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { id } = await params;
    const weeksParam = request.nextUrl.searchParams.get("weeks");
    const weeks = weeksParam ? parseInt(weeksParam, 10) || 8 : 8;
    const cycleTime = await insightService.getCycleTime(id, user.id, weeks);
    return successResponse(cycleTime);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Cycle time verisi alınamadı");
  }
}
