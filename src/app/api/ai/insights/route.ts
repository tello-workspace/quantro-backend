import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function GET(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return errorResponse("projectId parametresi gerekli", 400, "VALIDATION_ERROR");
    }

    // Kullanıcının projeye erişimi var mı kontrol et
    const { prisma } = await import("@/lib/prisma");
    const member = await prisma.organizationMember.findFirst({
      where: {
        userId: user.id,
        organization: {
          projects: { some: { id: projectId } },
        },
      },
    });

    if (!member) {
      return errorResponse("Bu projeye erişim yetkiniz yok", 403, "FORBIDDEN");
    }

    const insights = await aiService.generateProjectInsights(projectId);
    return successResponse({ insights });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    console.error("[AI INSIGHTS] Hata:", error);
    return errorResponse("İçgörüler alınamadı", 500, "INTERNAL_ERROR");
  }
}
