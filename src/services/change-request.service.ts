import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ConflictError } from "@/utils/errors";
import * as cardService from "@/services/card.service";
import * as columnService from "@/services/column.service";
import * as projectService from "@/services/project.service";
import * as notificationService from "@/services/notification.service";
import { broadcastToOrganization, SocketEvents } from "@/server/socket";
import type {
  CreateChangeRequestInput,
  ListChangeRequestsInput,
} from "@/schemas/change-request.schema";

const REQUEST_INCLUDE = {
  requestedBy: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } },
  targetCard: { select: { id: true, title: true } },
} as const;

async function getMembership(organizationId: string, userId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (!member) throw new ForbiddenError("Bu organizasyona erişim yetkiniz yok");
  return member;
}

// Talebin hangi organizasyona ait oldugunu istegin turune gore cozer ve
// ayni anda kullanicinin oraya erisimini dogrular.
async function resolveScope(input: CreateChangeRequestInput, userId: string) {
  if (input.type === "PROJECT_CREATE") {
    // Proje talebi organizasyon geneli; org id istemciden ayrica gelir
    throw new Error("PROJECT_CREATE icin resolveScopeForOrg kullanilmali");
  }

  if (input.type === "CARD_CREATE") {
    const column = await prisma.column.findUnique({
      where: { id: input.targetColumnId },
      select: { projectId: true, project: { select: { organizationId: true } } },
    });
    if (!column) throw new NotFoundError("Sütun");
    return {
      organizationId: column.project.organizationId,
      projectId: column.projectId,
      targetColumnId: input.targetColumnId,
      targetCardId: null as string | null,
    };
  }

  if (input.type === "CARD_UPDATE" || input.type === "CARD_DELETE") {
    const card = await prisma.card.findUnique({
      where: { id: input.targetCardId },
      select: {
        column: { select: { projectId: true, project: { select: { organizationId: true } } } },
      },
    });
    if (!card) throw new NotFoundError("Kart");
    return {
      organizationId: card.column.project.organizationId,
      projectId: card.column.projectId,
      targetColumnId: null as string | null,
      targetCardId: input.targetCardId,
    };
  }

  // COLUMN_CREATE
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { organizationId: true },
  });
  if (!project) throw new NotFoundError("Proje");
  return {
    organizationId: project.organizationId,
    projectId: input.projectId,
    targetColumnId: null as string | null,
    targetCardId: null as string | null,
  };
}

export async function createRequest(
  input: CreateChangeRequestInput,
  userId: string,
  organizationIdForProject?: string,
) {
  let scope: {
    organizationId: string;
    projectId: string | null;
    targetColumnId: string | null;
    targetCardId: string | null;
  };

  if (input.type === "PROJECT_CREATE") {
    if (!organizationIdForProject) {
      throw new NotFoundError("Organizasyon");
    }
    scope = {
      organizationId: organizationIdForProject,
      projectId: null,
      targetColumnId: null,
      targetCardId: null,
    };
  } else {
    scope = await resolveScope(input, userId);
  }

  const member = await getMembership(scope.organizationId, userId);

  // Admin zaten dogrudan yapabiliyor; talep akisina girmesine gerek yok
  if (member.role === "ADMIN") {
    throw new ConflictError(
      "Adminler değişikliği doğrudan yapabilir, talep oluşturmaya gerek yok",
    );
  }

  const request = await prisma.changeRequest.create({
    data: {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      type: input.type,
      payload: (input.payload ?? {}) as object,
      targetCardId: scope.targetCardId,
      targetColumnId: scope.targetColumnId,
      requestedById: userId,
    },
    include: REQUEST_INCLUDE,
  });

  // Sadece adminlere bildir; diger uyeleri ilgilendirmiyor
  const adminler = await prisma.organizationMember.findMany({
    where: { organizationId: scope.organizationId, role: "ADMIN" },
    select: { userId: true },
  });
  for (const admin of adminler) {
    await notificationService.createNotification({
      userId: admin.userId,
      type: "REQUEST_CREATED",
      message: `${request.requestedBy.name}: ${aciklama(request.type, request.payload)}`,
    });
  }

  broadcastToOrganization(scope.organizationId, SocketEvents.REQUEST_CREATED, request);

  return request;
}

export async function listRequests(
  organizationId: string,
  input: ListChangeRequestsInput,
  userId: string,
) {
  const member = await getMembership(organizationId, userId);

  const requests = await prisma.changeRequest.findMany({
    where: {
      organizationId,
      ...(input.status ? { status: input.status } : {}),
      // Uye yalnizca kendi taleplerini gorur, admin hepsini
      ...(member.role === "ADMIN" ? {} : { requestedById: userId }),
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: input.limit,
    relationLoadStrategy: "join",
    include: REQUEST_INCLUDE,
  });

  return requests;
}

async function getPendingOrThrow(requestId: string, userId: string) {
  const request = await prisma.changeRequest.findUnique({
    where: { id: requestId },
    include: REQUEST_INCLUDE,
  });
  if (!request) throw new NotFoundError("Talep");

  const member = await getMembership(request.organizationId, userId);
  if (member.role !== "ADMIN") {
    throw new ForbiddenError("Talepleri sadece adminler değerlendirebilir");
  }
  if (request.status !== "PENDING") {
    throw new ConflictError("Bu talep zaten sonuçlandırılmış");
  }

  return request;
}

// Onay: talep, ONAYLAYAN ADMIN'in kimligiyle uygulanir. Boylece mevcut
// servislerdeki ADMIN kontrolleri oldugu gibi calisir, ikinci bir yetki
// yolu acilmaz. Talebi kimin actigi kayitta (requestedById) duruyor.
async function applyRequest(
  request: Awaited<ReturnType<typeof getPendingOrThrow>>,
  adminId: string,
) {
  const payload = (request.payload ?? {}) as Record<string, unknown>;

  switch (request.type) {
    case "CARD_CREATE": {
      const card = await cardService.createCard(
        request.targetColumnId!,
        {
          title: payload.title as string,
          description: (payload.description as string) ?? undefined,
          priority: payload.priority as never,
          dueDate: (payload.dueDate as string) ?? undefined,
          assigneeIds: (payload.assigneeIds as string[]) ?? undefined,
        },
        adminId,
      );
      return { kind: "card" as const, id: card.id, title: card.title };
    }

    case "CARD_UPDATE": {
      const card = await cardService.updateCard(
        request.targetCardId!,
        {
          title: payload.title as string | undefined,
          description: payload.description as string | undefined,
          priority: payload.priority as never,
          dueDate: payload.dueDate as string | undefined,
          assigneeIds: (payload.assigneeIds as string[]) ?? undefined,
        },
        adminId,
      );
      return { kind: "card" as const, id: card.id, title: card.title };
    }

    case "CARD_DELETE": {
      const baslik = request.targetCard?.title ?? "";
      await cardService.deleteCard(request.targetCardId!, adminId);
      return { kind: "card" as const, id: request.targetCardId!, title: baslik };
    }

    case "COLUMN_CREATE": {
      const column = await columnService.createColumn(
        request.projectId!,
        {
          name: payload.name as string,
          wipLimit: (payload.wipLimit as number) ?? undefined,
        },
        adminId,
      );
      return { kind: "column" as const, id: column.id, title: column.name };
    }

    case "PROJECT_CREATE": {
      const project = await projectService.createProject(
        request.organizationId,
        {
          name: payload.name as string,
          description: (payload.description as string) ?? undefined,
        },
        adminId,
      );
      return { kind: "project" as const, id: project.id, title: project.name };
    }
  }
}

export async function approveRequest(requestId: string, userId: string, note?: string, modifiedPayload?: any) {
  const request = await getPendingOrThrow(requestId, userId);

  // If the admin modified the payload, update/merge it first
  if (modifiedPayload) {
    const newPayload = {
      ...((request.payload as any) || {}),
      ...modifiedPayload,
    };
    await prisma.changeRequest.update({
      where: { id: requestId },
      data: {
        payload: newPayload,
      },
    });
    request.payload = newPayload;
  }

  // Once uygula: uygulama patlarsa talep PENDING kalir, admin tekrar dener
  const sonuc = await applyRequest(request, userId);

  const updated = await prisma.changeRequest.update({
    where: { id: requestId },
    data: {
      status: "APPROVED",
      reviewedById: userId,
      reviewedAt: new Date(),
      reviewNote: note,
    },
    include: REQUEST_INCLUDE,
  });

  await notificationService.createNotification({
    userId: request.requestedById,
    type: "REQUEST_APPROVED",
    message: `Talebin onaylandı: ${aciklama(request.type, request.payload)}`,
    cardId: sonuc.kind === "card" ? sonuc.id : undefined,
  });

  broadcastToOrganization(request.organizationId, SocketEvents.REQUEST_REVIEWED, updated);

  return updated;
}

export async function rejectRequest(requestId: string, userId: string, note?: string) {
  const request = await getPendingOrThrow(requestId, userId);

  // Reddedilen talebin payload'i uygulanmaz; kayit gecmis icin durur
  const updated = await prisma.changeRequest.update({
    where: { id: requestId },
    data: {
      status: "REJECTED",
      reviewedById: userId,
      reviewedAt: new Date(),
      reviewNote: note,
    },
    include: REQUEST_INCLUDE,
  });

  await notificationService.createNotification({
    userId: request.requestedById,
    type: "REQUEST_REJECTED",
    message: note
      ? `Talebin reddedildi: ${aciklama(request.type, request.payload)} — ${note}`
      : `Talebin reddedildi: ${aciklama(request.type, request.payload)}`,
  });

  broadcastToOrganization(request.organizationId, SocketEvents.REQUEST_REVIEWED, updated);

  return updated;
}

// Bildirim metinleri icin kisa, okunabilir ozet
function aciklama(type: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case "CARD_CREATE":
      return `"${p.title}" kartını oluşturma talebi`;
    case "CARD_UPDATE":
      return "kart düzenleme talebi";
    case "CARD_DELETE":
      return "kart silme talebi";
    case "COLUMN_CREATE":
      return `"${p.name}" sütununu oluşturma talebi`;
    case "PROJECT_CREATE":
      return `"${p.name}" projesini oluşturma talebi`;
    default:
      return "değişiklik talebi";
  }
}
