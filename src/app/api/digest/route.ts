import { NextRequest } from "next/server";
import { runDailyDigest } from "@/services/digest.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError, ForbiddenError } from "@/utils/errors";
import { checkCronTriggerLimit } from "@/middleware/cronTriggerLimit";
import { prisma } from "@/lib/prisma";

// /api/scan ile ayni yetkilendirme deseni - bkz. o dosyadaki not.
async function authorizeCronRequest(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = request.headers.get("x-cron-secret");
  if (cronSecret && providedSecret === cronSecret) return null;

  const authError = await authenticate(request);
  if (authError) return authError;

  const user = (request as AuthenticatedRequest).user;
  const adminMembership = await prisma.organizationMember.findFirst({
    where: { userId: user.id, role: "ADMIN" },
    select: { userId: true },
  });
  if (!adminMembership) {
    throw new ForbiddenError("Bu işlemi tetikleme yetkiniz yok");
  }
  // /api/scan ile ayni gerekce: bu uc de TUM platformun kullanicilarina
  // e-posta gonderiyor, sayaci olmadigi icin herhangi bir org'un admini
  // istedigi siklikta ozet postasi tetikleyebiliyordu.
  return checkCronTriggerLimit("digest", user.id);
}

export async function POST(request: NextRequest) {
  try {
    const authError = await authorizeCronRequest(request);
    if (authError) return authError;

    const result = await runDailyDigest();
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Günlük özet başarısız");
  }
}
