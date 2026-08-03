import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { supabaseAdmin, ATTACHMENTS_BUCKET } from "@/lib/supabaseAdmin";

// Kapak gorselleri icin imzali URL. Depolama yapilandirilmamissa veya
// imzalama basarisiz olursa bos harita doner: kapak gorseli bir suslemedir,
// yokluğu panoyu calismaz hale getirmemeli.
const KAPAK_URL_TTL_SANIYE = 60 * 60; // 1 saat - pano oturumu icin yeterli

async function imzaliKapakUrlleri(yollar: string[]): Promise<Map<string, string>> {
  const harita = new Map<string, string>();
  if (!supabaseAdmin || yollar.length === 0) return harita;

  // Ayni gorsel birden fazla kartta olamaz ama yine de tekillestiriyoruz.
  const tekil = [...new Set(yollar)];

  try {
    const { data, error } = await supabaseAdmin.storage
      .from(ATTACHMENTS_BUCKET)
      .createSignedUrls(tekil, KAPAK_URL_TTL_SANIYE);

    if (error || !data) return harita;

    for (const kayit of data) {
      if (kayit.path && kayit.signedUrl) harita.set(kayit.path, kayit.signedUrl);
    }
  } catch (err) {
    console.warn("[board] Kapak görselleri imzalanamadı:", err);
  }

  return harita;
}

// Proje + uyelik tek sorguda: onceden proje bir sorgu, uyelik ayri bir
// sorgu ile cekiliyordu (iki gidis-donus). Iliski uzerinden filtreleyerek
// ikisini birlestiriyoruz; proje yok mu yoksa uye degil mi ayrimi icin
// yalnizca hata yolunda ikinci sorguyu atiyoruz.
async function checkProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organization: { members: { some: { userId } } } },
    select: { organization: { select: { members: { where: { userId }, select: { role: true } } } } },
  });

  if (project) return { role: project.organization.members[0].role };

  const exists = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!exists) throw new NotFoundError("Proje");
  throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
}

export async function getBoard(projectId: string, userId: string) {
  // Uzak veritabaninda her sorgu ~140ms. Erisim kontrolu pano sorgusundan
  // once sirayla beklenirse bu bedel iki kez daha odeniyor; ikisini paralel
  // baslatip yetki hatasini yine de veriyi donmeden firlatiyoruz.
  //
  const [access, columns] = await Promise.all([
    checkProjectAccess(projectId, userId),
    prisma.column.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
      include: {
        // Onceden hic limit yoktu - tek bir kolonda binlerce kart biriken bir
        // proje (en cok "Done" kolonu, hic temizlenmediginde) tum kartlari
        // tek istekte serialize etmeye calisirdi. Kart bazli gercek sayfalama
        // (cursor + "daha fazla yukle" UI'i) board'un tek-seferde-yukle
        // yapisini degistirmeyi gerektirir - bu, sinirsiz buyumeyi durduran
        // savunma amacli bir tavan. Normal boyuttaki bir projede hicbir
        // kolon bu sayiya yaklasmaz.
        cards: {
          take: 500,
          orderBy: { position: "asc" },
          where: { isArchived: false },
          include: {
            assignees: { include: { user: { select: { id: true, name: true, avatarUrl: true, badges: { include: { badge: { select: { id: true, name: true, color: true, icon: true } } } } } } } },
            labels: { include: { label: true } },
            // Panoda sadece "3/7" ilerleme rozeti icin - madde metinleri
            // TaskModal acilinca ayri bir istekle cekiliyor.
            checklistItems: { select: { done: true } },
            // Kapak gorseli: kartin EN ESKI gorsel eki kapak sayiliyor.
            // Ayri bir "kapak" isareti (semada yeni alan + migration)
            // gerektirmeyen, sifir yapilandirmali bir cozum; kullanici
            // gorseli ekledigi anda kart panoda kapakli goruunuyor.
            attachments: {
              where: { mimeType: { startsWith: "image/" } },
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { storagePath: true },
            },
          },
        },
      },
    }),
  ]);

  // Kapak gorselleri private bucket'ta, imzali URL gerekiyor. Kart basina
  // ayri istek atmak yerine TEK toplu cagri: 200 kartli bir panoda 200
  // gidis-donus, panoyu acilir acilmaz kullanilamaz hale getirirdi.
  const kapakYollari = columns
    .flatMap((c) => c.cards)
    .map((c) => c.attachments[0]?.storagePath)
    .filter((p): p is string => !!p);

  const kapakUrlleri = await imzaliKapakUrlleri(kapakYollari);

  const boardColumns: Record<string, { id: string; title: string; wipLimit: number | null; isDone: boolean; taskIds: string[] }> = {};
  const tasks: Record<string, unknown> = {};

  for (const col of columns) {
    const taskIds: string[] = [];
    for (const card of col.cards) {
      taskIds.push(card.id);
      tasks[card.id] = {
        id: card.id,
        title: card.title,
        description: card.description,
        dueDate: card.dueDate?.toISOString().split("T")[0],
        startDate: card.startDate?.toISOString().split("T")[0],
        columnId: card.columnId,
        position: card.position,
        priority: card.priority,
        storyPoints: card.storyPoints,
        lastActivityAt: card.lastActivityAt.toISOString(),
        assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
        labels: card.labels.map((cl) => ({
          id: cl.label.id,
          name: cl.label.name,
          color: cl.label.color,
        })),
        checklistTotal: card.checklistItems.length,
        checklistDone: card.checklistItems.filter((c) => c.done).length,
        coverUrl: card.attachments[0]
          ? (kapakUrlleri.get(card.attachments[0].storagePath) ?? null)
          : null,
      };
    }
    boardColumns[col.id] = {
      id: col.id,
      title: col.name,
      wipLimit: col.wipLimit,
      isDone: col.isDone,
      taskIds,
    };
  }

  return { columns: boardColumns, tasks, myRole: access.role };
}
