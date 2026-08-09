import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/utils/errors";

// Org bazli izolasyon: global admin yok. Kullanici yalnizca ADMIN oldugu
// organizasyonlarin hata kayitlarini gorebilir. HandleApiError, kayitlari
// olustuklari org'a baglar (organizationId); bir org'un admini Baska bir
// org'un stack trace / ic verilerini goremez.
async function listAdminOrganizationIds(userId: string): Promise<string[]> {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, role: "ADMIN" },
    select: { organizationId: true },
  });
  return memberships.map((m) => m.organizationId);
}

export async function listErrorLogs(userId: string, limit: number) {
  const adminOrgIds = await listAdminOrganizationIds(userId);
  if (adminOrgIds.length === 0) {
    throw new ForbiddenError("Hata kayıtlarını görüntüleme yetkiniz yok");
  }

  const take = Math.min(Math.max(limit || 50, 1), 200);

  return prisma.errorLog.findMany({
    // organizationId null olan kayitlar hicbir org'a atfedilmediği icin
    // listelenmez (kaydin org'u cozulememis / kimlik dogrulamasi olmayan
    // istekten gelmis olabilir - sizinti yuzeyini daraltmak guvenli yon).
    where: { organizationId: { in: adminOrgIds } },
    orderBy: { createdAt: "desc" },
    take,
  });
}
