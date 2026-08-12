import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

const setDigestPrefSchema = z.object({ enabled: z.boolean() });

export async function PATCH(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;
    const body = await request.json();
    const parsed = setDigestPrefSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse("Geçersiz tercih verisi", 400, "VALIDATION_ERROR");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { dailyDigestEnabled: parsed.data.enabled },
    });

    return successResponse({ enabled: parsed.data.enabled });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Özet tercihi güncellenemedi");
  }
}
