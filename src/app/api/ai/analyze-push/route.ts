import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { anahtarlaKartTasi } from "@/services/github-webhook.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkAiRateLimit } from "@/middleware/rateLimit";
import { AppError, NotFoundError } from "@/utils/errors";
import { prisma } from "@/lib/prisma";

// Analiz "bu gelistiriciye atanmis kartlar" uzerinde calisiyor, yani bir
// kullanici kimligi sart. Iki yol var:
//
// 1) JWT ile (uygulama icinden manuel tetikleme)
// 2) `x-cron-secret` + govdede `authorEmail` (CI / git hook). Endpoint
//    onceden YALNIZCA JWT kabul ediyordu; bu yuzden analiz motoru yazilmis
//    olmasina ragmen hicbir otomatik akisa baglanamiyordu - commit sonrasi
//    kart tasima elle diff yapistirmayi gerektiriyordu ki kimse yapmaz.
//
// Guven seviyesi /api/scan ile ayni: sirri elinde tutan, o e-postaya ait
// kartlari tasiyabilir. Sir yalnizca CI ortam degiskeninde durmali.
async function resolveUserId(request: NextRequest, authorEmail?: unknown): Promise<string> {
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = request.headers.get("x-cron-secret");

  if (cronSecret && providedSecret === cronSecret) {
    if (typeof authorEmail !== "string" || !authorEmail.trim()) {
      throw new AppError(400, "authorEmail gereklidir", "VALIDATION_ERROR");
    }
    const user = await prisma.user.findUnique({
      where: { email: authorEmail.trim().toLowerCase() },
      select: { id: true },
    });
    // Commit yazarinin Quantro hesabi olmayabilir (dis katkici, farkli git
    // e-postasi). Bu bir hata degil - sessizce atlanmasi gereken bir durum.
    if (!user) throw new NotFoundError("Bu e-postaya ait kullanıcı");
    return user.id;
  }

  const authError = await authenticate(request);
  if (authError) throw new AppError(401, "Yetkilendirme gerekli", "UNAUTHORIZED");
  return (request as AuthenticatedRequest).user.id;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const { commitMessage, diff, authorEmail } = (body ?? {}) as Record<string, unknown>;

    if (commitMessage === undefined || diff === undefined) {
      return errorResponse("commitMessage ve diff gereklidir", 400, "VALIDATION_ERROR");
    }

    const userId = await resolveUserId(request, authorEmail);

    // ANAHTAR ONCELIGI: commit mesajinda "QNT-42" gibi bir kart anahtari
    // varsa gelistirici hangi kartla ilgilendigini zaten soylemis demektir.
    // Deterministik yol hem hizli (tek sorgu, AI cagrisi yok) hem ucretsiz
    // hem de yanilmaz; AI ancak anahtar yokken devreye giriyor.
    //
    // Hiz limiti bu daldan ONCE gelmiyor: sinir AI kullanimini korumak icin
    // var, anahtar yolu saglayiciya hic gitmiyor.
    const anahtarlaTasinanlar = await anahtarlaKartTasi(userId, String(commitMessage));
    if (anahtarlaTasinanlar.length > 0) {
      return successResponse({
        movedCards: anahtarlaTasinanlar.map((k) => ({
          cardId: k.cardId,
          title: k.title,
          reason: `Commit mesajındaki ${k.anahtar} referansı`,
        })),
        // Istemci (VS Code eklentisi) hangi yolun calistigini kullaniciya
        // gosterebilsin: "AI tahmin etti" ile "sen soyledin" farkli seyler.
        source: "card-key" as const,
      });
    }

    const rateLimitError = checkAiRateLimit(userId, "ai:analyze-push");
    if (rateLimitError) return rateLimitError;

    const result = await aiService.analyzePushAndMoveCards(
      userId,
      String(commitMessage),
      String(diff),
    );
    return successResponse({ ...result, source: "ai" as const });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "Push analizi sırasında hata oluştu");
  }
}
