/**
 * Basit hata izleme altyapısı: beklenmeyen (AppError olmayan) hatalar hem
 * konsola yapılandırılmış biçimde yazılır hem de ErrorLog tablosuna düşer.
 * Validasyon/yetki gibi beklenen hatalar (400/401/403/404) buraya girmez —
 * sadece gerçek 500'ler loglanır.
 */
import * as Sentry from "@sentry/node";
import { prisma } from "@/lib/prisma";

interface LogErrorParams {
  error: unknown;
  method: string;
  path: string;
  userId?: string;
  // Hatanin olustugu organizasyon. Org bazli izolasyon icin: bir org'un
  // admini yalnizca kendi org'una ait kayitlari gorebilsin (bkz. error-log.service).
  organizationId?: string;
}

export async function logError({ error, method, path, userId, organizationId }: LogErrorParams) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;

  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      method,
      path,
      userId: userId ?? null,
      organizationId: organizationId ?? null,
      message,
    }),
  );

  try {
    await prisma.errorLog.create({
      data: { message, stack, method, path, userId, organizationId },
    });
  } catch (dbError) {
    console.error("[LOGGER] Hata veritabanina yazilamadi:", dbError);
  }

  Sentry.withScope((scope) => {
    scope.setTag("method", method);
    scope.setTag("path", path);
    if (userId) scope.setUser({ id: userId });
    if (organizationId) scope.setTag("organizationId", organizationId);
    Sentry.captureException(error instanceof Error ? error : new Error(message));
  });
}
