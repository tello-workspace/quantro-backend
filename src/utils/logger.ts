/**
 * Basit hata izleme altyapısı: beklenmeyen (AppError olmayan) hatalar hem
 * konsola yapılandırılmış biçimde yazılır hem de ErrorLog tablosuna düşer.
 * Validasyon/yetki gibi beklenen hatalar (400/401/403/404) buraya girmez —
 * sadece gerçek 500'ler loglanır.
 */
import { prisma } from "@/lib/prisma";

interface LogErrorParams {
  error: unknown;
  method: string;
  path: string;
  userId?: string;
}

export async function logError({ error, method, path, userId }: LogErrorParams) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;

  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      method,
      path,
      userId: userId ?? null,
      message,
    }),
  );

  try {
    await prisma.errorLog.create({
      data: { message, stack, method, path, userId },
    });
  } catch (dbError) {
    console.error("[LOGGER] Hata veritabanina yazilamadi:", dbError);
  }
}
