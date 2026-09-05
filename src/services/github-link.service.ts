import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import { checkProjectAccess } from "@/services/access-control.service";
import { webhookSecretUret } from "@/utils/github-signature";
import type { CreateGithubLinkInput, UpdateGithubLinkInput } from "@/schemas/github.schema";

// Depo baglantisinin yonetimi (CRUD). Olaylarin islenmesi
// github-webhook.service.ts'te.

// secret HICBIR okuma yolunda donmuyor: yalnizca createLink'in kendi
// yanitinda, bir kez. OutgoingWebhook ile ayni sozlesme - orada select
// verilmedigi icin PATCH yaniti sirri sizdiriyordu, ayni hatayi bastan
// engellemek icin her sorguda alan listesi acikca yaziliyor.
const GORUNUR_ALANLAR = {
  id: true,
  projectId: true,
  owner: true,
  repo: true,
  isActive: true,
  branchColumnId: true,
  prOpenColumnId: true,
  prMergedColumnId: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

async function adminSart(projectId: string, userId: string, eylem: string) {
  // checkProjectAccess gorunurluk/GUEST kuralini da uyguluyor: PRIVATE bir
  // projede org ADMIN'i bile ProjectMember degilse burada eleniyor.
  const { role } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError(`GitHub bağlantısını sadece adminler ${eylem}`);
}

/**
 * Verilen kolon id'lerinin hepsinin BU projeye ait oldugunu dogrular.
 *
 * Sema kolon id'lerini serbest cuid olarak aliyor ve yetki yalnizca URL'deki
 * projeyi koruyor. Aidiyet dogrulanmazsa bir admin govdeye baska bir
 * organizasyonun kolon id'sini yazip, o depodan gelen her PR'da kartlarin
 * yabanci bir panoya tasinmasini saglayabilirdi - otomasyon kurallarindaki
 * ayni kontrolun karsiligi.
 */
async function kolonlariDogrula(projectId: string, kolonIdleri: (string | null | undefined)[]) {
  const idler = kolonIdleri.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (idler.length === 0) return;

  const benzersiz = [...new Set(idler)];
  const bulunan = await prisma.column.count({
    where: { id: { in: benzersiz }, projectId },
  });
  if (bulunan !== benzersiz.length) {
    throw new ValidationError("Seçilen sütunlardan biri bu projeye ait değil");
  }
}

export async function getLink(projectId: string, userId: string) {
  await adminSart(projectId, userId, "görebilir");
  return prisma.githubRepoLink.findUnique({
    where: { projectId },
    select: GORUNUR_ALANLAR,
  });
}

/**
 * Baglantiyi kurar ve secret'i BIR KEZ dondurur.
 *
 * Kullanici bu secret'i GitHub'da depo ayarlarindaki webhook formuna
 * yapistiracak; bir daha gosterilmiyor (api-token.service.ts ile ayni desen).
 * Kaybederse baglantiyi silip yeniden kurar.
 */
export async function createLink(projectId: string, input: CreateGithubLinkInput, userId: string) {
  await adminSart(projectId, userId, "kurabilir");
  await kolonlariDogrula(projectId, [input.branchColumnId, input.prOpenColumnId, input.prMergedColumnId]);

  const mevcut = await prisma.githubRepoLink.findUnique({
    where: { projectId },
    select: { id: true },
  });
  // projectId semada tekil; anlasilir bir mesaj yerine P2002'den 500 donmesin.
  if (mevcut) throw new ValidationError("Bu projede zaten bir GitHub bağlantısı var");

  const secret = webhookSecretUret();
  const link = await prisma.githubRepoLink.create({
    data: {
      projectId,
      owner: input.owner,
      repo: input.repo,
      secret,
      branchColumnId: input.branchColumnId ?? null,
      prOpenColumnId: input.prOpenColumnId ?? null,
      prMergedColumnId: input.prMergedColumnId ?? null,
      createdById: userId,
    },
    select: GORUNUR_ALANLAR,
  });

  return { ...link, secret };
}

export async function updateLink(projectId: string, input: UpdateGithubLinkInput, userId: string) {
  await adminSart(projectId, userId, "değiştirebilir");

  const mevcut = await prisma.githubRepoLink.findUnique({
    where: { projectId },
    select: { id: true },
  });
  if (!mevcut) throw new NotFoundError("GitHub bağlantısı");

  await kolonlariDogrula(projectId, [input.branchColumnId, input.prOpenColumnId, input.prMergedColumnId]);

  return prisma.githubRepoLink.update({
    where: { projectId },
    data: {
      owner: input.owner,
      repo: input.repo,
      // undefined = "dokunma", null = "eslemeyi kaldir". Zod semasi ikisini
      // ayirt edebiliyor (nullable().optional()), bu ayrimi burada koruyoruz.
      branchColumnId: input.branchColumnId,
      prOpenColumnId: input.prOpenColumnId,
      prMergedColumnId: input.prMergedColumnId,
      isActive: input.isActive,
    },
    select: GORUNUR_ALANLAR,
  });
}

export async function deleteLink(projectId: string, userId: string) {
  await adminSart(projectId, userId, "silebilir");

  const mevcut = await prisma.githubRepoLink.findUnique({
    where: { projectId },
    select: { id: true },
  });
  if (!mevcut) throw new NotFoundError("GitHub bağlantısı");

  // Kart baglari ve teslimat kayitlari cascade ile gidiyor.
  await prisma.githubRepoLink.delete({ where: { projectId } });
}
