import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const body = await request.json();
    const { projectId, title } = body;

    if (!projectId || !title) {
      return errorResponse("projectId ve title gerekli", 400, "VALIDATION_ERROR");
    }

    // Projeye erişim kontrolü
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

    const data = await aiService.generateCardDetails(projectId, user.id, title);
    return successResponse(data);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    console.error("[AI FILL] Hata:", error);
    return errorResponse("AI detayları üretilemedi", 500, "INTERNAL_ERROR");
  }
}
