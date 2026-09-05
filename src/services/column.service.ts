import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, ValidationError } from "@/utils/errors";
import { checkProjectAccess } from "@/services/access-control.service";
import { broadcastToProject, SocketEvents } from "@/server/socket";
import type { CreateColumnInput, UpdateColumnInput } from "@/schemas/column.schema";

export async function createColumn(projectId: string, input: CreateColumnInput, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  // Yapisal degisiklik: uye dogrudan yapamaz, talep acar
  if (role !== "ADMIN") {
    throw new ForbiddenError(
      "Sütunu sadece adminler oluşturabilir. Sütun talebi gönderebilirsiniz.",
    );
  }

  // Pozisyon verilmemişse sona ekle
  let position = input.position;
  if (position === undefined) {
    const lastColumn = await prisma.column.findFirst({
      where: { projectId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    position = (lastColumn?.position ?? 0) + 1;
  }

  const column = await prisma.column.create({
    data: {
      projectId,
      name: input.name,
      position,
      wipLimit: input.wipLimit,
      isDone: input.isDone ?? false,
    },
  });

  broadcastToProject(projectId, SocketEvents.COLUMN_CREATED, {
    id: column.id,
    name: column.name,
    projectId,
    position: column.position,
    wipLimit: column.wipLimit ?? null,
    isDone: column.isDone,
  });

  return column;
}

export async function getColumns(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const columns = await prisma.column.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
    include: {
      _count: { select: { cards: true } },
    },
  });

  return columns;
}

export async function getColumnById(columnId: string, userId: string) {
  const column = await prisma.column.findUnique({ where: { id: columnId } });
  if (!column) throw new NotFoundError("Sütun");

  await checkProjectAccess(column.projectId, userId);

  return column;
}

const GECIS_KURALI_ALANLARI = [
  "transitionMode",
  "requireAssignee",
  "requireChecklistComplete",
  "requireDescription",
  "requireNoOpenBlockers",
] as const;

export async function updateColumn(columnId: string, input: UpdateColumnInput, userId: string) {
  const column = await prisma.column.findUnique({ where: { id: columnId } });
  if (!column) throw new NotFoundError("Sütun");

  const { role } = await checkProjectAccess(column.projectId, userId);

  // Gecis kurallari kartlarin akisini kilitleyebilir - rename/wipLimit'ten
  // farkli olarak sadece admin degistirebilir.
  const kuralDegisiyor = GECIS_KURALI_ALANLARI.some((alan) => input[alan] !== undefined);
  if (kuralDegisiyor && role !== "ADMIN") {
    throw new ForbiddenError("Geçiş kurallarını sadece adminler değiştirebilir");
  }

  const updated = await prisma.column.update({
    where: { id: columnId },
    data: input,
  });

  broadcastToProject(column.projectId, SocketEvents.COLUMN_UPDATED, {
    id: updated.id,
    name: updated.name,
    projectId: column.projectId,
    position: updated.position,
    wipLimit: updated.wipLimit ?? null,
    isDone: updated.isDone,
  });

  return updated;
}

export async function deleteColumn(columnId: string, userId: string) {
  const column = await prisma.column.findUnique({ where: { id: columnId } });
  if (!column) throw new NotFoundError("Sütun");

  const { role } = await checkProjectAccess(column.projectId, userId);

  // Kolon silmek cascade ile icindeki tum kartlari (yorum/checklist/ek/time-log
  // dahil) geri donusu olmadan siler. Tek kart silmek bile ADMIN isterken
  // (card.service.deleteCard) burada rol kontrolu yoktu - uye tum kolonu
  // silebiliyordu. Ayni yapisal degisiklik sartina baglaniyor.
  if (role !== "ADMIN") {
    throw new ForbiddenError(
      "Sütunu sadece adminler silebilir. Silme talebi gönderebilirsiniz.",
    );
  }

  await prisma.column.delete({ where: { id: columnId } });

  broadcastToProject(column.projectId, SocketEvents.COLUMN_DELETED, {
    columnId,
    projectId: column.projectId,
    deletedBy: userId,
  });
}

export async function reorderColumns(projectId: string, columnIds: string[], userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") {
    throw new ForbiddenError("Sütunları sadece adminler yeniden sıralayabilir.");
  }

  // Yetki yalnizca projectId uzerinden kontrol ediliyor, gelen id'ler ise
  // dogrudan guncelleniyordu: baska bir organizasyonun kolon id'leri
  // gonderilerek o panonun sirasi bozulabiliyordu. Once gelen listenin
  // tamaminin bu projeye ait oldugunu dogruluyoruz - yabanci ya da hic var
  // olmayan id $transaction'i P2025 ile patlatip 500 dondurmesin diye de
  // gerekli.
  const projeKolonlari = await prisma.column.findMany({
    where: { projectId },
    select: { id: true },
  });
  const projeKolonIdleri = new Set(projeKolonlari.map((k) => k.id));
  const yabanci = columnIds.filter((id) => !projeKolonIdleri.has(id));
  if (yabanci.length > 0) {
    throw new ValidationError("Sıralanan sütunlardan biri bu projeye ait değil");
  }

  // Batch update: gelen sıraya göre position'ları 0, 1, 2... yap
  // updateMany + projectId filtresi kiracı sinirini veritabani seviyesinde de
  // uygular (yukaridaki kontrol ile arasindaki yarista bile yazma sizmasin).
  const updates = columnIds.map((id, index) =>
    prisma.column.updateMany({
      where: { id, projectId },
      data: { position: index },
    }),
  );

  await prisma.$transaction(updates);

  return prisma.column.findMany({
    where: { projectId },
    orderBy: { position: "asc" },
  });
}
