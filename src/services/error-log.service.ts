import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/utils/errors";

// Global "admin" rolu yok; herhangi bir organizasyonda ADMIN olan kullanici
// hata kayitlarini gorebilir. Kucuk ekip icin yeterli, org bazli izolasyon
// gerektirmiyor cunku hatalar tum sistemi ilgilendiriyor.
async function assertCanViewErrorLogs(userId: string) {
  const adminMembership = await prisma.organizationMember.findFirst({
    where: { userId, role: "ADMIN" },
    select: { userId: true },
  });
  if (!adminMembership) {
    throw new ForbiddenError("Hata kayıtlarını görüntüleme yetkiniz yok");
  }
}

export async function listErrorLogs(userId: string, limit: number) {
  await assertCanViewErrorLogs(userId);

  const take = Math.min(Math.max(limit || 50, 1), 200);

  return prisma.errorLog.findMany({
    orderBy: { createdAt: "desc" },
    take,
  });
}
