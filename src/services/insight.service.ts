import { prisma } from "@/lib/prisma";
import { checkProjectAccess } from "@/services/access-control.service";
import type { Priority, CardType } from "@prisma/client";

const STALE_DAYS = 7;
const DEADLINE_RISK_DAYS = 3;
const BLOCKED_STALE_DAYS = 5;
const OVERLOAD_MULTIPLIER = 1.5;

const PRIORITY_WEIGHT: Record<Priority, number> = {
  URGENT: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 1,
};

export async function getProjectInsights(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const blockedStaleThreshold = new Date(now.getTime() - BLOCKED_STALE_DAYS * 24 * 60 * 60 * 1000);
  const deadlineThreshold = new Date(now.getTime() + DEADLINE_RISK_DAYS * 24 * 60 * 60 * 1000);

  // "Done" olmayan sütunlardaki tüm kartlar - stale/is yükü/deadline hesabının hepsi bu küme üzerinden
  const activeCards = await prisma.card.findMany({
    where: { column: { projectId, isDone: false }, isArchived: false },
    select: {
      id: true,
      title: true,
      priority: true,
      type: true,
      estimate: true,
      dueDate: true,
      lastActivityAt: true,
      columnId: true,
      column: { select: { id: true, name: true } },
      assignees: { select: { userId: true, user: { select: { id: true, name: true, avatarUrl: true } } } },
      blockedBy: {
        select: { blocker: { select: { id: true, column: { select: { isDone: true } } } } },
      },
    },
  });

  const staleCards = activeCards
    .filter((c) => c.lastActivityAt < staleThreshold)
    .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())
    .map((c) => ({
      id: c.id,
      title: c.title,
      columnId: c.columnId,
      columnName: c.column.name,
      lastActivityAt: c.lastActivityAt.toISOString(),
      assignees: c.assignees.map((a) => a.user),
    }));

  // Iş yükü dengesi: Done disindaki kartlari assignee'ye gore GROUP BY.
  // Agirlik: kartin efor tahmini (Card.estimate) varsa o kullanilir - artik
  // gercek bir olcut var. Tahmin girilmemis kartlarda onceki gibi oncelige
  // dusulur (URGENT=3, HIGH=2, diger=1) ki tahminsiz kartlar yuk hesabinda
  // sifir gorunup kisiyi "bossa cikarmasin".
  // Ortalamanin 1.5 kati ustundeki kisi "asiri yuklu" isaretlenir.
  const workloadMap = new Map<
    string,
    { user: { id: string; name: string; avatarUrl?: string | null }; weightedLoad: number; cardCount: number }
  >();
  for (const card of activeCards) {
    const weight = card.estimate ?? PRIORITY_WEIGHT[card.priority];
    for (const assignee of card.assignees) {
      const entry = workloadMap.get(assignee.userId) ?? {
        user: assignee.user,
        weightedLoad: 0,
        cardCount: 0,
      };
      entry.weightedLoad += weight;
      entry.cardCount += 1;
      workloadMap.set(assignee.userId, entry);
    }
  }

  const workloadEntries = Array.from(workloadMap.values());
  const averageLoad =
    workloadEntries.length > 0
      ? workloadEntries.reduce((sum, e) => sum + e.weightedLoad, 0) / workloadEntries.length
      : 0;

  const workload = workloadEntries
    .map((e) => ({
      userId: e.user.id,
      userName: e.user.name,
      avatarUrl: (e.user as { avatarUrl?: string | null }).avatarUrl ?? null,
      cardCount: e.cardCount,
      weightedLoad: e.weightedLoad,
      overloaded: averageLoad > 0 && e.weightedLoad > averageLoad * OVERLOAD_MULTIPLIER,
    }))
    .sort((a, b) => b.weightedLoad - a.weightedLoad);

  // Darbogaz: aktif kart sayisi wipLimit'i asan sutunlar
  const columnsWithLimit = await prisma.column.findMany({
    where: { projectId, wipLimit: { not: null } },
    select: { id: true, name: true, wipLimit: true, _count: { select: { cards: true } } },
  });

  const wipViolations = columnsWithLimit
    .filter((col) => col.wipLimit !== null && col._count.cards > col.wipLimit)
    .map((col) => ({
      columnId: col.id,
      columnName: col.name,
      wipLimit: col.wipLimit as number,
      cardCount: col._count.cards,
    }));

  // Deadline risk: dueDate <= 3 gun VE (5+ gundur hareketsiz VEYA hala bloklanmis)
  const deadlineRisks = activeCards
    .filter((c) => {
      if (!c.dueDate || c.dueDate > deadlineThreshold) return false;
      const isStale = c.lastActivityAt < blockedStaleThreshold;
      const isBlocked = c.blockedBy.some((dep) => !dep.blocker.column.isDone);
      return isStale || isBlocked;
    })
    .sort((a, b) => (a.dueDate as Date).getTime() - (b.dueDate as Date).getTime())
    .map((c) => ({
      id: c.id,
      title: c.title,
      columnId: c.columnId,
      columnName: c.column.name,
      dueDate: (c.dueDate as Date).toISOString(),
      assignees: c.assignees.map((a) => a.user),
    }));

  // Is tipi kirilimi: aktif kartlarin (Done disindaki) CardType'a gore sayisi.
  // Sifir olan tipler de gosterilsin diye ONCE tum tipler 0'la baslatiliyor.
  const typeBreakdown = Object.fromEntries(
    (["EPIC", "STORY", "TASK", "BUG", "SUBTASK"] as CardType[]).map((t) => [t, 0]),
  ) as Record<CardType, number>;
  for (const card of activeCards) {
    typeBreakdown[card.type] += 1;
  }

  return {
    generatedAt: now.toISOString(),
    staleCards,
    workload,
    wipViolations,
    deadlineRisks,
    typeBreakdown,
  };
}

// Not: Activity artik doluyor (card/comment servisleri logActivity cagiriyor),
// ama bu fonksiyon yine de Card tablosunun kendi zaman damgalarindan
// hesapliyor - basit ve yeterli, degistirmeye gerek yok.
export async function getWeeklySummary(projectId: string, userId: string) {
  await checkProjectAccess(projectId, userId);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [createdCards, completedCards, newComments, pendingStaleCount] = await Promise.all([
    prisma.card.findMany({
      where: { column: { projectId }, createdAt: { gte: since }, isArchived: false },
      select: { creatorId: true, creator: { select: { id: true, name: true } } },
    }),
    prisma.card.findMany({
      where: { column: { projectId, isDone: true }, updatedAt: { gte: since }, isArchived: false },
      select: { id: true },
    }),
    prisma.comment.findMany({
      where: { card: { column: { projectId } }, createdAt: { gte: since } },
      select: { authorId: true, author: { select: { id: true, name: true } } },
    }),
    prisma.card.count({
      where: {
        column: { projectId, isDone: false },
        lastActivityAt: { lt: new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  const activityCount = new Map<string, { user: { id: string; name: string }; count: number }>();
  for (const card of createdCards) {
    const entry = activityCount.get(card.creatorId) ?? { user: card.creator, count: 0 };
    entry.count += 1;
    activityCount.set(card.creatorId, entry);
  }
  for (const comment of newComments) {
    const entry = activityCount.get(comment.authorId) ?? { user: comment.author, count: 0 };
    entry.count += 1;
    activityCount.set(comment.authorId, entry);
  }

  const mostActive = Array.from(activityCount.values()).sort((a, b) => b.count - a.count)[0];

  return {
    since: since.toISOString(),
    cardsCreated: createdCards.length,
    cardsCompleted: completedCards.length,
    commentsAdded: newComments.length,
    mostActiveMember: mostActive
      ? { userId: mostActive.user.id, userName: mostActive.user.name, activityCount: mostActive.count }
      : null,
    pendingStaleCount,
  };
}

// YEREL takvim gunune gore anahtar - eachDay de cursor'u YEREL Y/M/D ile
// kuruyor (asagida). toISOString() (UTC) kullanilsaydi UTC+ bolgelerde yerel
// gece yarisi bir onceki UTC gunune duserdi, eachDay'in urettigi gunlerle
// toDayKey'in anahtari sessizce bir gun kayardi.
function toDayKey(d: Date): string {
  const yil = d.getFullYear();
  const ay = String(d.getMonth() + 1).padStart(2, "0");
  const gun = String(d.getDate()).padStart(2, "0");
  return `${yil}-${ay}-${gun}`;
}

function eachDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function eachWeekStart(start: Date, end: Date): Date[] {
  const weeks: Date[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    weeks.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

const CFD_DAYS_DEFAULT = 30;
const CFD_DAYS_MIN = 7;
const CFD_DAYS_MAX = 90;
const OTHER_COLUMN_KEY = "__other__";

export interface CumulativeFlowResult {
  projectId: string;
  days: number;
  columns: { id: string; name: string }[];
  series: { date: string; counts: Record<string, number> }[];
  totalCards: number;
  cardsWithMoveHistory: number;
}

/**
 * Gercek (sutun bazli) kumulatif akis: her gun icin her sutundaki kart
 * sayisi. Onceki deneme (bkz. commit 36e4ae6) sadece "olusturulan vs
 * tamamlanan" iki bandini gosteriyordu ve "anlamli bulunmadi" diye geri
 * alinmisti - bu, gercek darbogazi (hangi SÜTUN tikaniyor) gostermiyordu.
 * Bu surum sutun sutun WIP'i zaman icinde takip ediyor.
 *
 * Kisit: CARD_MOVED aktivitesi sutun ADI tutuyor, id degil (schema'nin
 * kendi ornegi: data: {"from":"To Do","to":"In Progress"}). Bir sutun
 * yeniden adlandirilirsa o degisiklikten ONCEKI hareketler artik hicbir
 * MEVCUT sutunla eslesmez - bunlar sessizce yutulmuyor, "Diğer" kovasina
 * dusuyor ki toplam tutarli kalsin ve veri kaybi gorunur olsun.
 */
export async function getCumulativeFlow(
  projectId: string,
  userId: string,
  days: number = CFD_DAYS_DEFAULT,
): Promise<CumulativeFlowResult> {
  await checkProjectAccess(projectId, userId);
  const clampedDays = Math.min(Math.max(days, CFD_DAYS_MIN), CFD_DAYS_MAX);

  const end = new Date();
  const start = new Date(end.getTime() - (clampedDays - 1) * 24 * 60 * 60 * 1000);

  const [columns, cards] = await Promise.all([
    prisma.column.findMany({ where: { projectId }, orderBy: { position: "asc" }, select: { id: true, name: true } }),
    prisma.card.findMany({
      where: { column: { projectId }, isArchived: false },
      select: { id: true, createdAt: true, columnId: true },
    }),
  ]);

  const cardIds = cards.map((c) => c.id);
  const moves =
    cardIds.length > 0
      ? await prisma.activity.findMany({
          where: { projectId, cardId: { in: cardIds }, type: "CARD_MOVED" },
          select: { cardId: true, createdAt: true, data: true },
          orderBy: { createdAt: "asc" },
        })
      : [];

  const movesByCard = new Map<string, { at: Date; from: string; to: string }[]>();
  for (const m of moves) {
    if (!m.cardId) continue;
    const veri = m.data as { from?: string; to?: string } | null;
    if (!veri?.from || !veri?.to) continue;
    const liste = movesByCard.get(m.cardId) ?? [];
    liste.push({ at: m.createdAt, from: veri.from, to: veri.to });
    movesByCard.set(m.cardId, liste);
  }

  const columnIdByName = new Map(columns.map((c) => [c.name, c.id]));
  const columnNameById = new Map(columns.map((c) => [c.id, c.name]));

  function kolonAdiZamanNoktasinda(card: (typeof cards)[number], zaman: Date): string {
    const hareketler = movesByCard.get(card.id) ?? [];
    if (hareketler.length === 0 || zaman < hareketler[0].at) {
      return hareketler.length > 0 ? hareketler[0].from : (columnNameById.get(card.columnId) ?? OTHER_COLUMN_KEY);
    }
    let sonuc = hareketler[0].to;
    for (const hareket of hareketler) {
      if (zaman >= hareket.at) sonuc = hareket.to;
      else break;
    }
    return sonuc;
  }

  const gunler = eachDay(start, end);
  const series = gunler.map((gun) => {
    const gunSonu = new Date(gun.getFullYear(), gun.getMonth(), gun.getDate(), 23, 59, 59, 999);
    const counts: Record<string, number> = {};
    for (const col of columns) counts[col.id] = 0;
    counts[OTHER_COLUMN_KEY] = 0;

    for (const card of cards) {
      if (card.createdAt > gunSonu) continue;
      const adi = kolonAdiZamanNoktasinda(card, gunSonu);
      const id = columnIdByName.get(adi) ?? OTHER_COLUMN_KEY;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return { date: toDayKey(gun), counts };
  });

  return {
    projectId,
    days: clampedDays,
    columns: columns.map((c) => ({ id: c.id, name: c.name })),
    series,
    totalCards: cards.length,
    cardsWithMoveHistory: movesByCard.size,
  };
}

const CYCLE_TIME_WEEKS_DEFAULT = 8;
const CYCLE_TIME_WEEKS_MIN = 4;
const CYCLE_TIME_WEEKS_MAX = 26;

export interface CycleTimeResult {
  projectId: string;
  overallAverageDays: number | null;
  sampledCards: number;
  totalDoneCards: number;
  weeklySeries: { weekStart: string; averageDays: number | null; count: number }[];
}

/**
 * Ortalama cycle time (yaratimdan Done'a girise kadar), haftalik trend
 * olarak. "Hizlaniyor muyuz yavasliyor muyuz" sorusunu dogrudan cevaplar -
 * CARD_COMPLETED aktivitesi (sutun ADINA degil, sadece zamana bagli) uzerine
 * kurulu oldugu icin sutun yeniden adlandirmalarindan etkilenmez, CFD'den
 * daha guvenilir bir sinyal.
 */
export async function getCycleTime(
  projectId: string,
  userId: string,
  weeks: number = CYCLE_TIME_WEEKS_DEFAULT,
): Promise<CycleTimeResult> {
  await checkProjectAccess(projectId, userId);
  const clampedWeeks = Math.min(Math.max(weeks, CYCLE_TIME_WEEKS_MIN), CYCLE_TIME_WEEKS_MAX);

  const doneCards = await prisma.card.findMany({
    where: { column: { projectId, isDone: true }, isArchived: false },
    select: { id: true, createdAt: true },
  });
  if (doneCards.length === 0) {
    return { projectId, overallAverageDays: null, sampledCards: 0, totalDoneCards: 0, weeklySeries: [] };
  }

  const cardIds = doneCards.map((c) => c.id);
  const completions = await prisma.activity.findMany({
    where: { projectId, cardId: { in: cardIds }, type: "CARD_COMPLETED" },
    select: { cardId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  // Kart basina EN SON tamamlanma - kart done->baska->done sekerse (bounce)
  // en guncel "bitis" bilgisi budur.
  const completedAtByCard = new Map<string, Date>();
  for (const c of completions) {
    if (!c.cardId || completedAtByCard.has(c.cardId)) continue;
    completedAtByCard.set(c.cardId, c.createdAt);
  }

  const createdAtByCard = new Map(doneCards.map((c) => [c.id, c.createdAt]));
  const samples = Array.from(completedAtByCard.entries()).map(([cardId, completedAt]) => {
    const olusturulma = createdAtByCard.get(cardId)!;
    const gunFarki = (completedAt.getTime() - olusturulma.getTime()) / (24 * 60 * 60 * 1000);
    return { completedAt, cycleDays: Math.max(gunFarki, 0) };
  });

  const ortalama = (liste: { cycleDays: number }[]) =>
    liste.length > 0 ? Math.round((liste.reduce((s, x) => s + x.cycleDays, 0) / liste.length) * 10) / 10 : null;

  const end = new Date();
  const start = new Date(end.getTime() - (clampedWeeks - 1) * 7 * 24 * 60 * 60 * 1000);
  const haftalar = eachWeekStart(start, end);

  const weeklySeries = haftalar.map((haftaBaslangic, i) => {
    const haftaBitis = i + 1 < haftalar.length ? new Date(haftalar[i + 1].getTime() - 1) : end;
    const buHaftakiler = samples.filter((s) => s.completedAt >= haftaBaslangic && s.completedAt <= haftaBitis);
    return { weekStart: toDayKey(haftaBaslangic), averageDays: ortalama(buHaftakiler), count: buHaftakiler.length };
  });

  return {
    projectId,
    overallAverageDays: ortalama(samples),
    sampledCards: samples.length,
    totalDoneCards: doneCards.length,
    weeklySeries,
  };
}
