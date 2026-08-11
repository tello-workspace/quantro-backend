import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import * as notificationService from "@/services/notification.service";
import { notifyBlockerResolved } from "@/services/dependency.service";
import { logActivity } from "@/services/activity.service";
import * as automationService from "@/services/automation.service";
import { notifyWatchers } from "@/services/watcher.service";
import { allocateCardNumber } from "@/services/card-key.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import type { CreateCardInput, UpdateCardInput } from "@/schemas/card.schema";
import type { Priority } from "@prisma/client";

const assigneeInclude = {
  assignees: {
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  },
} as const;

// Kolonun projesine ve organizasyonuna erişim kontrolü
async function checkColumnAccess(columnId: string, userId: string) {
  const column = await prisma.column.findUnique({
    where: { id: columnId },
    select: { name: true, projectId: true, project: { select: { organizationId: true } } },
  });
  if (!column) throw new NotFoundError("Sütun");

  const member = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: column.project.organizationId,
        userId,
      },
    },
  });
  if (!member) throw new ForbiddenError("Bu projeye erişim yetkiniz yok");

  return {
    role: member.role,
    projectId: column.projectId,
    columnName: column.name,
    organizationId: column.project.organizationId,
  };
}

// Fraksiyonel pozisyon hesapla
// Verilen kolonda en sondaki position'ı bulup +1 verir
async function getNextPosition(columnId: string): Promise<number> {
  const lastCard = await prisma.card.findFirst({
    where: { columnId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (lastCard?.position ?? 0) + 1;
}

// parentCardId ayni projedeki bir karta mi isaret ediyor ve dongu olusturmuyor mu?
// (kartin kendi alt-gorevini kendine ebeveyn secmesi gibi bir A->B->A durumu)
async function validateParentCard(projectId: string, cardId: string | undefined, parentCardId: string) {
  const cycleError = () => new ValidationError("Bir kart kendi alt görevinin altına bağlanamaz");

  if (cardId && parentCardId === cardId) {
    throw cycleError();
  }

  const parent = await prisma.card.findUnique({
    where: { id: parentCardId },
    select: { parentCardId: true, column: { select: { projectId: true } } },
  });
  if (!parent || parent.column.projectId !== projectId) {
    throw new NotFoundError("Üst kart");
  }

  if (!cardId) return;

  // parentCardId'den yukari dogru zincir takip edilir - eger bu zincirde
  // cardId'ye rastlanirsa, yeni ebeveynlik bir dongu olustururdu.
  let current = parent.parentCardId;
  const visited = new Set<string>([parentCardId]);
  while (current) {
    if (current === cardId) throw cycleError();
    if (visited.has(current)) break; // guvenlik: sonsuz donguye girme
    visited.add(current);
    const next = await prisma.card.findUnique({ where: { id: current }, select: { parentCardId: true } });
    current = next?.parentCardId ?? null;
  }
}

// Atanan kişilerin hepsinin organizasyon üyesi olduğunu doğrula
async function validateAssignees(columnId: string, assigneeIds: string[]) {
  if (assigneeIds.length === 0) return;

  const column = await prisma.column.findUnique({
    where: { id: columnId },
    select: { project: { select: { organizationId: true } } },
  });
  if (!column) throw new NotFoundError("Sütun");

  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId: column.project.organizationId,
      userId: { in: assigneeIds },
    },
    select: { userId: true },
  });

  if (members.length !== assigneeIds.length) {
    throw new ForbiddenError("Atanan kişilerden biri bu organizasyonun üyesi değil");
  }
}

// Kart basligi icin urun sinirimiz. Ayni deger createCardSchema,
// change-request ve template semalarinda da geciyor.
export const MAX_TITLE_LENGTH = 200;

// Basligi SERVIS katmaninda kisaltiyoruz, reddetmiyoruz.
//
// Bu fonksiyonu route'un yani sira AI arac calistiricisi ve otomasyon motoru
// da cagiriyor; onlar Zod semasindan gecmiyor. Reddetmek AI akisini
// kullaniciya anlamsiz bir hatayla bolerdi - modelin urettigi uzun bir
// cumleyi basliga sigdirmak, isi tamamen basarisiz saymaktan iyi. Tasan
// kisim aciklamaya tasiniyor ki metin kaybolmasin.
function normalizeTitle(input: { title: string; description?: string | null }) {
  if (input.title.length <= MAX_TITLE_LENGTH) {
    return { title: input.title, description: input.description };
  }

  const kisaltilmis = `${input.title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
  const tasan = input.title;
  const aciklama = input.description?.trim()
    ? `${input.description}\n\n---\n${tasan}`
    : tasan;

  console.warn(`[card] Baslik ${input.title.length} karakterdi, ${MAX_TITLE_LENGTH}'e kisaltildi.`);
  return { title: kisaltilmis, description: aciklama };
}

export async function createCard(columnId: string, input: CreateCardInput, userId: string) {
  const { role, projectId } = await checkColumnAccess(columnId, userId);
  if (role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler kart oluşturabilir");
  }

  const assigneeIds = input.assigneeIds ?? [];
  await validateAssignees(columnId, assigneeIds);

  if (input.parentCardId) {
    await validateParentCard(projectId, undefined, input.parentCardId);
  }

  const position = input.position ?? (await getNextPosition(columnId));

  // AI ve otomasyon bu servisi dogrudan cagiriyor (route semasini atlayarak),
  // sinir bu yuzden burada uygulaniyor.
  const { title, description } = normalizeTitle(input);

  // Kart numarası (QNT-42'nin 42'si). Kart yaratmadan HEMEN önce alınıyor;
  // araya bir hata girerse o numara boşa gider (dizide delik olur) ama iki
  // kart asla aynı numarayı almaz - Jira'nın davranışı da bu.
  const number = await allocateCardNumber(projectId);

  const card = await prisma.card.create({
    data: {
      columnId,
      number,
      title,
      description,
      creatorId: userId,
      priority: (input.priority as Priority) ?? "MEDIUM",
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      position,
      lastActivityAt: new Date(),
      parentCardId: input.parentCardId ?? undefined,
      estimate: input.estimate ?? undefined,
      assignees: {
        create: assigneeIds.map((id) => ({ userId: id })),
      },
    },
    include: assigneeInclude,
  });

  for (const assigneeId of assigneeIds) {
    await notificationService.createNotification({
      userId: assigneeId,
      type: "ASSIGNED",
      message: `"${card.title}" kartı size atandı`,
      cardId: card.id,
    });
  }

  broadcastToProject(projectId, SocketEvents.CARD_CREATED, {
    id: card.id,
    title: card.title,
    description: card.description,
    columnId: card.columnId,
    projectId,
    assignees: card.assignees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
    priority: card.priority,
    dueDate: card.dueDate?.toISOString() ?? null,
    startDate: card.startDate?.toISOString() ?? null,
    position: card.position,
    parentCardId: card.parentCardId,
  });

  await logActivity({ projectId, userId, type: "CARD_CREATED", cardId: card.id });

  await automationService.runRulesForTrigger({
    projectId,
    trigger: "CARD_CREATED",
    cardId: card.id,
    columnId,
  });

  return card;
}

export async function getCards(columnId: string, userId: string) {
  await checkColumnAccess(columnId, userId);

  const cards = await prisma.card.findMany({
    where: { columnId, isArchived: false },
    orderBy: { position: "asc" },
    include: {
      ...assigneeInclude,
      _count: { select: { comments: true } },
    },
  });

  return cards;
}

// Arsivlenen kartlari (soft-delete) listeler - board'da gorunmez ama kurtarilabilir.
export async function getArchivedCards(columnId: string, userId: string) {
  await checkColumnAccess(columnId, userId);

  return prisma.card.findMany({
    where: { columnId, isArchived: true },
    orderBy: { archivedAt: "desc" },
    include: assigneeInclude,
  });
}

export async function getCardById(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: {
      ...assigneeInclude,
      // project.key kart detayında "QNT-42" rozetini çizmek için geliyor:
      // kartın kendi numarası tek başına anlamsız, önek projede duruyor.
      column: {
        select: { id: true, name: true, projectId: true, project: { select: { key: true } } },
      },
      comments: {
        orderBy: { createdAt: "desc" },
        include: { author: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      },
      labels: { include: { label: true } },
      blocking: {
        include: { blocked: { select: { id: true, title: true } } },
      },
      blockedBy: {
        include: { blocker: { select: { id: true, title: true } } },
      },
      parent: { select: { id: true, title: true } },
      subtasks: {
        select: { id: true, title: true, column: { select: { isDone: true } } },
        orderBy: { createdAt: "asc" },
      },
      customFieldValues: {
        include: { field: { select: { id: true, name: true, type: true, options: true } } },
      },
    },
  });

  if (!card) throw new NotFoundError("Kart");

  // Yetki kontrolü: kartın kolonunun projesine erişim var mı?
  await checkColumnAccess(card.columnId, userId);

  return card;
}

export async function updateCard(cardId: string, input: UpdateCardInput, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { assignees: { select: { userId: true } } },
  });
  if (!card) throw new NotFoundError("Kart");

  // Baslik sinirini yalnizca baslik GERCEKTEN degistiginde uyguluyoruz.
  // Arayuz her kaydetmede tum alanlari geri gonderiyor; siniri kosulsuz
  // uygulasaydik, gecmiste sinirin ustunde kaydedilmis bir kart (AI route
  // semasini atlayarak olusturdugunda oluyordu) sonsuza dek duzenlenemez
  // kalirdi - kullanici basligi kisaltmak isterse bile istek reddedilirdi.
  if (input.title !== undefined && input.title !== card.title && input.title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`Kart başlığı en fazla ${MAX_TITLE_LENGTH} karakter olabilir`);
  }

  const { role, projectId, columnName: oldColumnName } = await checkColumnAccess(card.columnId, userId);

  // Yetki modeli: yapisal degisiklikler ADMIN'e ait. Uye kart TASIYABILIR
  // (kanban akisi bozulmasin), ama icerik alanlarini ve atamayi dogrudan
  // degistiremez; bunun icin degisiklik talebi acar (change-request.service).
  if (input.assigneeIds !== undefined && role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler görev ataması yapabilir");
  }

  const icerikAlanlariDegisiyor =
    input.title !== undefined ||
    input.description !== undefined ||
    input.priority !== undefined ||
    input.dueDate !== undefined ||
    input.startDate !== undefined ||
    input.parentCardId !== undefined ||
    input.estimate !== undefined;

  if (icerikAlanlariDegisiyor && role !== "ADMIN") {
    throw new ForbiddenError(
      "Kart içeriğini sadece adminler düzenleyebilir. Değişiklik talebi gönderebilirsiniz.",
    );
  }

  if (input.parentCardId) {
    await validateParentCard(projectId, cardId, input.parentCardId);
  }

  // Kolon değişikliği varsa hedef kolonun da erişilebilir olduğunu kontrol et
  const isColumnChange = input.columnId && input.columnId !== card.columnId;
  let newColumnName: string | undefined;
  if (isColumnChange && input.columnId) {
    const destAccess = await checkColumnAccess(input.columnId, userId);
    newColumnName = destAccess.columnName;

    // Bu genel PATCH ucu her zaman AYNI proje icinde tasima icin tasarlandi
    // (otomasyon, AI, toplu islem, degisiklik talebi hep bunu cagiriyor).
    // Baska bir projeye tasima etiket/ozel alan gibi proje-bazli verinin ne
    // olacagina karar vermek gerektiriyor - bu yuzden ayri, bilinçli bir
    // uctan (moveCardToProject) yapilmasi sart; burada sessizce izin verilirse
    // otomasyon kurallari gibi beklenmeyen cagiranlar veriyi fark etmeden
    // bozabilir.
    if (destAccess.projectId !== projectId) {
      throw new ValidationError(
        "Kart başka bir projeye bu uçtan taşınamaz - moveCardToProject kullanın",
      );
    }
  }

  const hasFieldEdits =
    input.title !== undefined ||
    input.description !== undefined ||
    input.priority !== undefined ||
    input.dueDate !== undefined ||
    input.startDate !== undefined ||
    input.estimate !== undefined;

  const oldAssigneeIds = new Set(card.assignees.map((a) => a.userId));
  let newlyAssignedIds: string[] = [];

  if (input.assigneeIds !== undefined) {
    const colId = input.columnId ?? card.columnId;
    await validateAssignees(colId, input.assigneeIds);
    newlyAssignedIds = input.assigneeIds.filter((id) => !oldAssigneeIds.has(id));
  }

  const updateData: Record<string, unknown> = {};
  if (input.title !== undefined) updateData.title = input.title;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.priority !== undefined) updateData.priority = input.priority as Priority;
  if (input.dueDate !== undefined) updateData.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  if (input.startDate !== undefined) updateData.startDate = input.startDate ? new Date(input.startDate) : null;
  if (input.parentCardId !== undefined) updateData.parentCardId = input.parentCardId;
  if (input.columnId !== undefined) updateData.columnId = input.columnId;
  if (input.position !== undefined) updateData.position = input.position;
  if (input.estimate !== undefined) updateData.estimate = input.estimate;
  if (input.assigneeIds !== undefined) {
    updateData.assignees = {
      deleteMany: {},
      create: input.assigneeIds.map((id) => ({ userId: id })),
    };
  }

  // Kolon değişikliği var ama position verilmemişse sona ekle
  if (isColumnChange && input.position === undefined) {
    const lastCard = await prisma.card.findFirst({
      where: { columnId: input.columnId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    updateData.position = (lastCard?.position ?? 0) + 1;
  }

  // Kartta değişiklik var → lastActivityAt güncelle
  if (Object.keys(updateData).length > 0) {
    updateData.lastActivityAt = new Date();
  }

  let updated = await prisma.card.update({
    where: { id: cardId },
    data: updateData,
    include: assigneeInclude,
  });

  // Sadece yeni eklenen atananlara bildirim gönder
  for (const assigneeId of newlyAssignedIds) {
    await notificationService.createNotification({
      userId: assigneeId,
      type: "ASSIGNED",
      message: `"${updated.title}" kartı size atandı`,
      cardId: updated.id,
    });
  }

  if (isColumnChange) {
    broadcastToProject(projectId, SocketEvents.CARD_MOVED, {
      cardId: updated.id,
      fromColumnId: card.columnId,
      toColumnId: updated.columnId,
      position: updated.position,
      projectId,
    });

    await logActivity({
      projectId,
      userId,
      type: "CARD_MOVED",
      cardId: updated.id,
      data: { from: oldColumnName, to: newColumnName },
    });

    await notifyWatchers(
      updated.id,
      userId,
      `"${updated.title}" kartı "${oldColumnName}" sütunundan "${newColumnName}" sütununa taşındı`,
    );

    // Kart Done sütununa taşındıysa, onu bekleyen kartların sahiplerine haber ver
    const newColumn = await prisma.column.findUnique({
      where: { id: updated.columnId },
      select: { isDone: true },
    });
    if (newColumn?.isDone) {
      await notifyBlockerResolved(updated.id, updated.title);
      await logActivity({ projectId, userId, type: "CARD_COMPLETED", cardId: updated.id });
    }

    await automationService.runRulesForTrigger({
      projectId,
      trigger: "CARD_MOVED_TO_COLUMN",
      cardId: updated.id,
      columnId: updated.columnId,
    });

    // Otomasyon kurallari ayni karti (ornegin ASSIGN_USER ile assignees'i)
    // degistirmis olabilir ve kendi dogru card:updated yayinini az once yapti.
    // Asagidaki kosulsuz son yayin ve HTTP yaniti hala yukaridaki ESKI
    // `updated` snapshot'ini kullansaydi, otomasyonun yayinladigi guncel veriyi
    // hemen ardindan eski veriyle ezip herkesin panosunda (ozellikle bu istegi
    // atan kullanicinin kendi sekmesinde, HTTP yaniti da bu eski veriyi
    // tasidigi icin) sayfa yenilenene kadar gorunmez hale getirirdi.
    updated = await prisma.card.findUniqueOrThrow({
      where: { id: cardId },
      include: assigneeInclude,
    });
  }

  if (newlyAssignedIds.length > 0) {
    broadcastToProject(projectId, SocketEvents.CARD_ASSIGNED, {
      cardId: updated.id,
      cardTitle: updated.title,
      assignees: updated.assignees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
    });

    await logActivity({
      projectId,
      userId,
      type: "CARD_ASSIGNED",
      cardId: updated.id,
      data: { assignedTo: updated.assignees.map((a) => a.user.name) },
    });
  }

  if (hasFieldEdits) {
    await logActivity({ projectId, userId, type: "CARD_UPDATED", cardId: updated.id });
  }

  broadcastToProject(projectId, SocketEvents.CARD_UPDATED, {
    id: updated.id,
    title: updated.title,
    description: updated.description,
    columnId: updated.columnId,
    projectId,
    assignees: updated.assignees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
    priority: updated.priority,
    dueDate: updated.dueDate?.toISOString() ?? null,
    startDate: updated.startDate?.toISOString() ?? null,
    position: updated.position,
    parentCardId: updated.parentCardId,
    estimate: updated.estimate,
  });

  return updated;
}

export interface DuplicateCardOptions {
  targetColumnId?: string;
  includeLabels?: boolean;
  includeAssignees?: boolean;
  includeChecklist?: boolean;
  includeAttachments?: boolean;
  includeCustomFields?: boolean;
}

// Karti kopyalar - ayni kolona ya da (istege bagli) baska bir projenin
// kolonuna. Etiket ve ozel alanlar proje-bazli oldugu icin hedef BASKA
// projeyse bunlar ID ile eslesmez: etiket isim eslesirse hedefteki karsiligina
// baglanir, eslesmezse ve ozel alan degerleri HER ZAMAN sessizce
// dusurulur - cagiran taraf droppedLabels/droppedCustomFields ile kullaniciya
// haber vermeli.
export async function duplicateCard(cardId: string, userId: string, options: DuplicateCardOptions = {}) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: {
      assignees: true,
      labels: { include: { label: true } },
      checklistItems: true,
      attachments: true,
      customFieldValues: { include: { field: true } },
    },
  });
  if (!card) throw new NotFoundError("Kart");

  const { role, projectId: sourceProjectId, organizationId: sourceOrgId } = await checkColumnAccess(
    card.columnId,
    userId,
  );
  if (role !== "ADMIN") {
    throw new ForbiddenError("Sadece adminler kart kopyalayabilir");
  }

  const targetColumnId = options.targetColumnId ?? card.columnId;
  const destAccess = await checkColumnAccess(targetColumnId, userId);
  if (destAccess.organizationId !== sourceOrgId) {
    throw new ForbiddenError("Kart farklı bir organizasyona kopyalanamaz");
  }
  const isCrossProject = destAccess.projectId !== sourceProjectId;

  const droppedLabels: string[] = [];
  let labelIdsToAttach: string[] = [];
  if (options.includeLabels !== false && card.labels.length > 0) {
    if (!isCrossProject) {
      labelIdsToAttach = card.labels.map((cl) => cl.labelId);
    } else {
      const targetLabels = await prisma.label.findMany({ where: { projectId: destAccess.projectId } });
      for (const cl of card.labels) {
        const match = targetLabels.find((l) => l.name.toLowerCase() === cl.label.name.toLowerCase());
        if (match) labelIdsToAttach.push(match.id);
        else droppedLabels.push(cl.label.name);
      }
    }
  }

  const droppedCustomFields: string[] = [];
  let customFieldValuesToAttach: { fieldId: string; value: string | null }[] = [];
  if (options.includeCustomFields !== false && card.customFieldValues.length > 0) {
    if (!isCrossProject) {
      customFieldValuesToAttach = card.customFieldValues.map((v) => ({ fieldId: v.fieldId, value: v.value }));
    } else {
      droppedCustomFields.push(...card.customFieldValues.map((v) => v.field.name));
    }
  }

  const assigneeIdsToAttach =
    options.includeAssignees !== false ? card.assignees.map((a) => a.userId) : [];

  const number = await allocateCardNumber(destAccess.projectId);
  const lastCard = await prisma.card.findFirst({
    where: { columnId: targetColumnId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = (lastCard?.position ?? 0) + 1;

  const newCard = await prisma.card.create({
    data: {
      columnId: targetColumnId,
      number,
      title: `${card.title} (kopya)`,
      description: card.description,
      creatorId: userId,
      priority: card.priority,
      dueDate: card.dueDate,
      startDate: card.startDate,
      position,
      assignees: { create: assigneeIdsToAttach.map((id) => ({ userId: id })) },
      labels: { create: labelIdsToAttach.map((labelId) => ({ labelId })) },
      customFieldValues:
        customFieldValuesToAttach.length > 0 ? { create: customFieldValuesToAttach } : undefined,
      checklistItems:
        options.includeChecklist !== false && card.checklistItems.length > 0
          ? {
              create: card.checklistItems.map((item) => ({
                text: item.text,
                done: item.done,
                position: item.position,
              })),
            }
          : undefined,
      attachments:
        options.includeAttachments !== false && card.attachments.length > 0
          ? {
              create: card.attachments.map((att) => ({
                uploaderId: userId,
                fileName: att.fileName,
                storagePath: att.storagePath,
                fileSize: att.fileSize,
                mimeType: att.mimeType,
              })),
            }
          : undefined,
    },
    include: assigneeInclude,
  });

  broadcastToProject(destAccess.projectId, SocketEvents.CARD_CREATED, {
    id: newCard.id,
    title: newCard.title,
    description: newCard.description,
    columnId: newCard.columnId,
    projectId: destAccess.projectId,
    assignees: newCard.assignees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
    priority: newCard.priority,
    dueDate: newCard.dueDate?.toISOString() ?? null,
    startDate: newCard.startDate?.toISOString() ?? null,
    position: newCard.position,
    parentCardId: newCard.parentCardId,
  });

  await logActivity({ projectId: destAccess.projectId, userId, type: "CARD_CREATED", cardId: newCard.id });

  return { card: newCard, droppedLabels, droppedCustomFields };
}

// Karti BASKA BIR PROJENIN kolonuna tasir (updateCard'in columnId yolu bunu
// bilerek reddediyor). Etiketler isim eslesirse hedefteki karsiligina
// baglanir, eslesmezse dusurulur; ozel alan degerleri proje-bazli oldugu icin
// her zaman dusurulur. Kart numarasi hedef projenin sayacindan yeniden
// alinir - projeler arasi tasinan bir kart eski projenin onekini tasimaya
// devam etmemeli (orn. "QNT-42" baska projeye tasinca o projenin kendi
// anahtarini almali).
export async function moveCardToProject(cardId: string, targetColumnId: string, userId: string) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { labels: { include: { label: true } }, customFieldValues: { include: { field: true } } },
  });
  if (!card) throw new NotFoundError("Kart");

  const {
    role,
    projectId: sourceProjectId,
    organizationId: sourceOrgId,
    columnName: oldColumnName,
  } = await checkColumnAccess(card.columnId, userId);
  if (role !== "ADMIN") {
    throw new ForbiddenError("Kartı sadece adminler başka bir projeye taşıyabilir");
  }

  const destAccess = await checkColumnAccess(targetColumnId, userId);
  if (destAccess.organizationId !== sourceOrgId) {
    throw new ForbiddenError("Kart farklı bir organizasyona taşınamaz");
  }
  if (destAccess.projectId === sourceProjectId) {
    throw new ValidationError("Hedef kolon zaten bu projede - normal taşıma ucunu kullanın");
  }

  const droppedLabels: string[] = [];
  const matchedLabelIds: string[] = [];
  if (card.labels.length > 0) {
    const targetLabels = await prisma.label.findMany({ where: { projectId: destAccess.projectId } });
    for (const cl of card.labels) {
      const match = targetLabels.find((l) => l.name.toLowerCase() === cl.label.name.toLowerCase());
      if (match) matchedLabelIds.push(match.id);
      else droppedLabels.push(cl.label.name);
    }
    await prisma.cardLabel.deleteMany({ where: { cardId } });
    if (matchedLabelIds.length > 0) {
      await prisma.cardLabel.createMany({ data: matchedLabelIds.map((labelId) => ({ cardId, labelId })) });
    }
  }

  const droppedCustomFields = card.customFieldValues.map((v) => v.field.name);
  if (card.customFieldValues.length > 0) {
    await prisma.cardCustomFieldValue.deleteMany({ where: { cardId } });
  }

  const [number, lastCard] = await Promise.all([
    allocateCardNumber(destAccess.projectId),
    prisma.card.findFirst({
      where: { columnId: targetColumnId },
      orderBy: { position: "desc" },
      select: { position: true },
    }),
  ]);
  const position = (lastCard?.position ?? 0) + 1;

  const updated = await prisma.card.update({
    where: { id: cardId },
    data: { columnId: targetColumnId, position, number, lastActivityAt: new Date() },
    include: assigneeInclude,
  });

  // CARD_MOVED tek proje odasi varsayiyor (fromColumnId/toColumnId ayni
  // board'da bekleniyor) - iki ayri proje icin eski odaya "silindi",
  // yeni odaya "olusturuldu" yayinlamak mevcut frontend dinleyicileriyle
  // dogru calisan tek yol.
  broadcastToProject(sourceProjectId, SocketEvents.CARD_DELETED, { cardId: updated.id, projectId: sourceProjectId });
  broadcastToProject(destAccess.projectId, SocketEvents.CARD_CREATED, {
    id: updated.id,
    title: updated.title,
    description: updated.description,
    columnId: updated.columnId,
    projectId: destAccess.projectId,
    assignees: updated.assignees.map((a) => ({ id: a.user.id, name: a.user.name, avatarUrl: a.user.avatarUrl })),
    priority: updated.priority,
    dueDate: updated.dueDate?.toISOString() ?? null,
    startDate: updated.startDate?.toISOString() ?? null,
    position: updated.position,
    parentCardId: updated.parentCardId,
  });

  const destProject = await prisma.project.findUnique({ where: { id: destAccess.projectId }, select: { name: true } });

  await logActivity({
    projectId: sourceProjectId,
    userId,
    type: "CARD_MOVED",
    cardId: updated.id,
    data: { from: oldColumnName, to: `${destProject?.name ?? "başka proje"} / ${destAccess.columnName}` },
  });

  return { card: updated, droppedLabels, droppedCustomFields };
}

export async function deleteCard(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({ 
    where: { id: cardId },
    include: { labels: true }
  });
  if (!card) throw new NotFoundError("Kart");

  const { role, projectId } = await checkColumnAccess(card.columnId, userId);
  if (role !== "ADMIN") {
    throw new ForbiddenError(
      "Kartı sadece adminler silebilir. Silme talebi gönderebilirsiniz.",
    );
  }

  const labelIds = card.labels.map((cl) => cl.labelId);

  await prisma.card.delete({ where: { id: cardId } });

  // Clean up orphaned labels
  if (labelIds.length > 0) {
    for (const labelId of labelIds) {
      const usageCount = await prisma.cardLabel.count({
        where: { labelId },
      });
      if (usageCount === 0) {
        await prisma.label.delete({ where: { id: labelId } }).catch((err) => {
          console.warn(`[Label Cleanup] Orphaned label silinirken hata: ${labelId}`, err.message);
        });
      }
    }
  }

  broadcastToProject(projectId, SocketEvents.CARD_DELETED, { cardId, projectId });
}

// Karti arsivler (soft-delete): veri silinmez, isArchived=true olur ve
// board/stale/tarama sorgularindan gizlenir. Geri yuklenebilir.
export async function archiveCard(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { columnId: true, isArchived: true } });
  if (!card) throw new NotFoundError("Kart");

  const { projectId } = await checkColumnAccess(card.columnId, userId);
  if (card.isArchived) return; // zaten arsivli - idempotent

  await prisma.card.update({
    where: { id: cardId },
    data: { isArchived: true, archivedAt: new Date(), archivedById: userId },
  });

  broadcastToProject(projectId, SocketEvents.CARD_UPDATED, { id: cardId, isArchived: true, projectId });
}

// Arsivlenen karti geri yukler.
export async function restoreCard(cardId: string, userId: string) {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { columnId: true, isArchived: true } });
  if (!card) throw new NotFoundError("Kart");

  const { projectId } = await checkColumnAccess(card.columnId, userId);
  if (!card.isArchived) return; // zaten aktif - idempotent

  await prisma.card.update({
    where: { id: cardId },
    data: { isArchived: false, archivedAt: null, archivedById: null },
  });

  broadcastToProject(projectId, SocketEvents.CARD_UPDATED, { id: cardId, isArchived: false, projectId });
}

// Proje genelinde arsivlenen kartlari listeler (Arsiv ekrani). Kolon bazli
// getArchivedCards'tan farkli olarak tum kolonlari tarar - kullanici hangi
// kolonda arsivlendigini hatirlamak zorunda kalmasin.
export async function getArchivedCardsForProject(projectId: string, userId: string) {
  const member = await prisma.organizationMember.findFirst({
    where: { userId, organization: { projects: { some: { id: projectId } } } },
  });
  if (!member) {
    const exists = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!exists) throw new NotFoundError("Proje");
    throw new ForbiddenError("Bu projeye erişim yetkiniz yok");
  }

  return prisma.card.findMany({
    where: { column: { projectId }, isArchived: true },
    orderBy: { archivedAt: "desc" },
    include: {
      column: { select: { id: true, name: true } },
      archivedBy: { select: { id: true, name: true, avatarUrl: true } },
    },
  });
}
