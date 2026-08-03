import { NextRequest } from "next/server";
import * as githubService from "@/services/github.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// GitHub profilini okuyup ozet doner. BILEREK kaydetmiyor: kullanici gelen
// veriyi formda gorup istedigini alsin, istemedigini birakabilsin. Sessizce
// profilin uzerine yazmak, elle girilmis dogru bilgiyi ezme riski tasirdi.
export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    // Kullanici kimligi yalnizca yetki icin gerekli; veri kullanicinin
    // gonderdigi URL'den okunuyor (kaydedilmis githubUrl'den degil), boylece
    // kaydetmeden once onizleme yapilabiliyor.
    void (request as AuthenticatedRequest).user;

    const body = await request.json().catch(() => null);
    const githubUrl = (body as { githubUrl?: unknown } | null)?.githubUrl;

    if (typeof githubUrl !== "string" || !githubUrl.trim()) {
      return errorResponse("githubUrl gereklidir", 400, "VALIDATION_ERROR");
    }

    const ozet = await githubService.fetchGithubProfile(githubUrl);
    return successResponse(ozet);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "GitHub profili alınamadı");
  }
}
