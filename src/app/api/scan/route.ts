import { NextRequest } from "next/server";
import { runNightlyScan } from "@/services/scan.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError, ForbiddenError } from "@/utils/errors";
import { checkCronTriggerLimit } from "@/middleware/cronTriggerLimit";
import { prisma } from "@/lib/prisma";

// Bu endpoint TUM organizasyonlardaki TUM projeleri tarar - eskiden sadece
// giris yapmis olmak yetiyordu, yani herhangi bir kullanici diledigi kadar
// tetikleyip paylasilan DB'ye agir yuk bindirebilir ve bildirim spam'i
// yaratabilirdi. Iki yoldan biri gecerli:
// 1) `x-cron-secret` header'i CRON_SECRET ile eslesirse (GitHub Actions'daki
//    zamanlanmis is buradan cagirir, bkz. .github/workflows/nightly-scan.yml)
// 2) Istek giris yapmis VE herhangi bir organizasyonda ADMIN olan bir
//    kullanicidan geliyorsa (manuel/test tetikleme icin)
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
  // ADMIN kontrolu "herhangi bir org'da admin mi" diye baktigi icin kendi
  // org'unu acan herkes buraya girebiliyor, tarama ise TUM organizasyonlarda
  // is uretiyor. Sayac olmadan istek dongude atilip yabanci panolarda tekrar
  // tekrar otomasyon/bildirim tetikleyebiliyordu; manuel tetikleme kullanici
  // basina saatte 1 ile sinirli (zamanlanmis is secret ile yukarida cikiyor).
  return checkCronTriggerLimit("scan", user.id);
}

// Gece taramasini elle tetiklemek icin (test + gerekirse manuel calistirma).
export async function POST(request: NextRequest) {
  try {
    const authError = await authorizeCronRequest(request);
    if (authError) return authError;

    const result = await runNightlyScan();
    return successResponse(result);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Tarama başarısız");
  }
}
