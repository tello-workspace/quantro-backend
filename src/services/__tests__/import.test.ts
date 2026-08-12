import { describe, it, expect, afterAll } from "vitest";
import * as importService from "@/services/import.service";
import { ForbiddenError, ValidationError } from "@/utils/errors";
import { prisma } from "@/lib/prisma";
import { createWorkspace, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

const trelloOrnek = JSON.stringify({
  lists: [
    { id: "list1", name: "To Do" },
    { id: "list2", name: "Doing" },
  ],
  members: [{ id: "m1", fullName: "Member User" }],
  labels: [{ id: "l1", name: "bug", color: "red" }],
  checklists: [{ id: "c1", idCard: "card1", name: "Adımlar", checkItems: [{ name: "adım 1", state: "complete" }] }],
  cards: [
    {
      id: "card1",
      name: "İlk kart",
      desc: "açıklama",
      idList: "list1",
      closed: false,
      idLabels: ["l1"],
      idMembers: ["m1"],
      labels: [{ name: "bug" }],
    },
    {
      id: "card2",
      name: "İkinci kart",
      idList: "list2",
      closed: false,
      idLabels: [],
      idMembers: [],
    },
    { id: "card3", name: "Arşivlenmiş", idList: "list1", closed: true },
  ],
});

const jiraOrnek =
  "Issue key,Summary,Status,Assignee,Priority,Labels\n" +
  'TST-1,"İlk iş, virgüllü",To Do,Member User,High,backend\n' +
  "TST-2,İkinci iş,Doing,,Low,\n";

describe("içe aktarma - önizleme", () => {
  it("trello json'u ayrıştırıp sütun/etiket/atanan önerir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const preview = await importService.previewImport(ws.project.id, "TRELLO_JSON", trelloOrnek, ws.admin.id);

    expect(preview.totalCards).toBe(2); // arşivlenmiş kart hariç
    expect(preview.columns.map((c) => c.name).sort()).toEqual(["Doing", "To Do"]);
    expect(preview.labels).toEqual([{ name: "bug", cardCount: 1 }]);
    expect(preview.assignees).toHaveLength(1);
    expect(preview.assignees[0].matchedUserId).toBe(ws.member.id);
  });

  it("jira csv'yi ayrıştırıp durumları sütun olarak önerir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const preview = await importService.previewImport(ws.project.id, "JIRA_CSV", jiraOrnek, ws.admin.id);

    expect(preview.totalCards).toBe(2);
    expect(preview.columns.map((c) => c.name).sort()).toEqual(["Doing", "To Do"]);
    expect(preview.assignees[0].matchedUserId).toBe(ws.member.id);
  });

  it("üye olmayan biri önizleme bile yapamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      importService.previewImport(ws.project.id, "TRELLO_JSON", trelloOrnek, ws.outsider.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("üye ama admin olmayan biri önizleme yapamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      importService.previewImport(ws.project.id, "TRELLO_JSON", trelloOrnek, ws.member.id),
    ).rejects.toThrow(ForbiddenError);
  });

  it("bozuk json ValidationError fırlatır", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      importService.previewImport(ws.project.id, "TRELLO_JSON", "{bozuk", ws.admin.id),
    ).rejects.toThrow(ValidationError);
  });
});

describe("içe aktarma - uygula", () => {
  it("kartları, etiketleri, checklist'i ve atamayı kümе bazlı yazar", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const sonuc = await importService.applyImport(
      ws.project.id,
      "TRELLO_JSON",
      trelloOrnek,
      {
        list1: { mode: "existing", columnId: ws.todo.id },
        list2: { mode: "new", name: "Doing" },
      },
      { "Member User": ws.member.id },
      ws.admin.id,
    );

    expect(sonuc.createdCards).toBe(2);
    expect(sonuc.createdColumns).toBe(1);
    expect(sonuc.createdLabels).toBe(1);
    expect(sonuc.skippedCards).toBe(0);

    const kartlar = await prisma.card.findMany({
      where: { column: { projectId: ws.project.id } },
      include: { labels: { include: { label: true } }, assignees: true, checklistItems: true },
      orderBy: { number: "asc" },
    });
    expect(kartlar).toHaveLength(2);

    const ilkKart = kartlar.find((k) => k.title === "İlk kart")!;
    expect(ilkKart.columnId).toBe(ws.todo.id);
    expect(ilkKart.labels.map((l) => l.label.name)).toEqual(["bug"]);
    expect(ilkKart.assignees.map((a) => a.userId)).toEqual([ws.member.id]);
    expect(ilkKart.checklistItems).toHaveLength(1);
    expect(ilkKart.checklistItems[0].done).toBe(true);

    const ikinciKart = kartlar.find((k) => k.title === "İkinci kart")!;
    expect(ikinciKart.columnId).not.toBe(ws.todo.id);
    expect(ikinciKart.columnId).not.toBe(ws.done.id);
  }, 60000);

  it("atlanan sütundaki kartlar içe aktarılmaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const sonuc = await importService.applyImport(
      ws.project.id,
      "TRELLO_JSON",
      trelloOrnek,
      {
        list1: { mode: "existing", columnId: ws.todo.id },
        list2: { mode: "skip" },
      },
      {},
      ws.admin.id,
    );

    expect(sonuc.createdCards).toBe(1);
    expect(sonuc.skippedCards).toBe(1);
  }, 60000);

  it("üye ama admin olmayan biri uygulayamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      importService.applyImport(
        ws.project.id,
        "TRELLO_JSON",
        trelloOrnek,
        { list1: { mode: "existing", columnId: ws.todo.id }, list2: { mode: "skip" } },
        {},
        ws.member.id,
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});
