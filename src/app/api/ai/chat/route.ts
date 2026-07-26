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
    const { projectId, messages } = body;

    if (!projectId || !messages || !Array.isArray(messages)) {
      return errorResponse("projectId ve messages (array) gerekli", 400, "VALIDATION_ERROR");
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

    const reply = await aiService.sendMessage(projectId, user.id, messages);
    return successResponse({ reply });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    console.error("[AI CHAT] Hata:", error);
    return errorResponse("AI mesajı gönderilemedi", 500, "INTERNAL_ERROR");
  }
}
