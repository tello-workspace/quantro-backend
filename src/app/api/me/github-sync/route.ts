import { NextRequest } from "next/server";
import * as githubService from "@/services/github.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { AppError } from "@/utils/errors";

// GitHub profilini okur ve KAYDEDER.
//
// Onceden bilerek kaydetmiyordu; gerekce "kullanici gelen veriyi formda gorup
// istedigini alsin" idi. Pratikte bu iki sorun uretti: gelen 8 alanin yalnizca
// 2'si (bio, diller) forma giriyordu, kalan 6'si atiliyordu; ve kullanici
// ayrica "Kaydet"e basmadikca hicbiri kalici olmuyordu - yani senkron cogu
// zaman hicbir iz birakmadan geciyordu.
//
// Ezme riski alan bazinda cozuldu (bkz. syncGithubProfileToUser): GitHub'a ait
// olgular uzerine yaziliyor, kullanicinin kendi yazdiklari yalnizca bossa
// dolduruluyor, diller birlestiriliyor.
export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;

    const body = await request.json().catch(() => null);
    const githubUrl = (body as { githubUrl?: unknown } | null)?.githubUrl;

    if (typeof githubUrl !== "string" || !githubUrl.trim()) {
      return errorResponse("githubUrl gereklidir", 400, "VALIDATION_ERROR");
    }

    const sonuc = await githubService.syncGithubProfileToUser(user.id, githubUrl);
    return successResponse({
      ...sonuc.profil,
      yazilan: sonuc.yazilan,
      korunan: sonuc.korunan,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "GitHub profili alınamadı");
  }
}
