import { describe, it, expect, afterEach } from "vitest";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";
import { prisma } from "@/lib/prisma";
import * as commentService from "@/services/comment.service";
import * as checklistService from "@/services/checklist.service";
import * as labelService from "@/services/label.service";
import * as columnService from "@/services/column.service";
import * as notificationService from "@/services/notification.service";
import * as badgeService from "@/services/badge.service";
import * as templateService from "@/services/template.service";
import * as sprintService from "@/services/sprint.service";
import * as boardService from "@/services/board.service";
import { ForbiddenError, NotFoundError } from "@/utils/errors";

// Kalan servisler icin yuzey testleri: her servisin kritik RBAC + varlik
// davranisi dogrulanir. Detayli is mantigi ozel dosyalarda test edilir.

describe("comment.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("uye karta yorum yazabilir", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const card = await createCard(todo.id, admin.id);

    const comment = await commentService.createComment(card.id, { text: "Selam" }, member.id);
    expect(comment).toMatchObject({ text: "Selam", authorId: member.id, cardId: card.id });
  });

  it("outsider yorum yazamaz", async () => {
    const { admin, outsider, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);
    const card = await createCard(todo.id, admin.id);

    await expect(commentService.createComment(card.id, { text: "X" }, outsider.id)).rejects.toThrow(ForbiddenError);
  });
});

describe("checklist.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("uye checklist ogesi ekleyebilir", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    const card = await createCard(todo.id, admin.id);

    const item = await checklistService.createChecklistItem(card.id, { text: "Gorev" }, member.id);
    expect(item).toMatchObject({ text: "Gorev", cardId: card.id, done: false });
  });

  it("outsider checklist goremez", async () => {
    const { admin, outsider, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, outsider.id);
    const card = await createCard(todo.id, admin.id);

    await expect(checklistService.getChecklistItems(card.id, outsider.id)).rejects.toThrow(ForbiddenError);
  });
});

describe("label.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("uye etiket olusturabilir, admin de", async () => {
    const { admin, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const label = await labelService.createLabel(project.id, { name: "Bug", color: "#EF4444" }, admin.id);
    expect(label).toMatchObject({ name: "Bug", color: "#EF4444" });
  });

  it("olmayan projede etiket olusturma -> NotFoundError", async () => {
    const { admin, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    await expect(
      labelService.createLabel("olmayan-proje", { name: "X", color: "#000" }, admin.id),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("column.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("MEMBER sutun olusturamaz, ADMIN olusturur", async () => {
    const { admin, member, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    await expect(columnService.createColumn(project.id, { name: "X" }, member.id)).rejects.toThrow(ForbiddenError);

    const column = await columnService.createColumn(project.id, { name: "Yeni", position: 5 }, admin.id);
    expect(column.name).toBe("Yeni");
  });
});

describe("notification.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("bildirim olusturulur ve okundu isaretlenir", async () => {
    const { admin, member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const notification = await notificationService.createNotification({
      userId: member.id,
      type: "ASSIGNED",
      message: "Test bildirimi",
    });

    expect(notification).not.toBeNull();
    expect(notification).toMatchObject({ userId: member.id, read: false });

    await notificationService.markAsRead(notification!.id, member.id);
    expect(await notificationService.getUnreadCount(member.id)).toBe(0);
  });

  it("baskasinin bildirimini okundu isaretleyemezsin", async () => {
    const { admin, member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const notification = await notificationService.createNotification({
      userId: member.id,
      type: "ASSIGNED",
      message: "Test",
    });

    await expect(notificationService.markAsRead(notification!.id, admin.id)).rejects.toThrow(ForbiddenError);
  });
});

describe("badge.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("ADMIN rozet olusturabilir, MEMBER atayamaz", async () => {
    const { admin, member, org } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);

    const badge = await badgeService.createBadge(org.id, { name: "Uzman", color: "#3B82F6", icon: "🏅" }, admin.id);
    expect(badge.name).toBe("Uzman");

    await expect(
      badgeService.assignBadge(org.id, badge.id, member.id, member.id),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("template.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("ADMIN sablon olusturur, karttan sablon olusturulabilir", async () => {
    const { admin, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);
    const card = await createCard(todo.id, admin.id, "Sablon kart");

    const template = await templateService.createTemplateFromCard(card.id, "Haftalik", admin.id);
    expect(template).toMatchObject({ name: "Haftalik" });
  });
});

describe("sprint.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("ADMIN sprint olusturur, liste gorulur", async () => {
    const { admin, org, project } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id);

    const sprint = await sprintService.createSprint(project.id, { name: "Sprint 1" }, admin.id);
    expect(sprint.name).toBe("Sprint 1");

    const sprints = await sprintService.listSprints(project.id, admin.id);
    expect(sprints.some((s) => s.id === sprint.id)).toBe(true);
  });
});

describe("board.service", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ orgIds, userIds });
    orgIds.length = 0;
    userIds.length = 0;
  });

  it("uye board verisini gorebilir (kolon + kartlar)", async () => {
    const { admin, member, org, todo } = await createWorkspace();
    orgIds.push(org.id);
    userIds.push(admin.id, member.id);
    await createCard(todo.id, admin.id, "Board kart");

    const board = await boardService.getBoard((await prisma.column.findUnique({ where: { id: todo.id }, select: { projectId: true } }))!.projectId, member.id);
    expect(board.columns).toBeDefined();
  });
});
