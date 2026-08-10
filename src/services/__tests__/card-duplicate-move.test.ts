import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import * as cardService from "@/services/card.service";
import { ForbiddenError, ValidationError } from "@/utils/errors";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

async function createSecondProject(organizationId: string, ownerId: string, key: string) {
  const project = await prisma.project.create({
    data: { name: `${key} projesi`, key, organizationId, ownerId },
  });
  const column = await prisma.column.create({
    data: { projectId: project.id, name: "Backlog", position: 1 },
  });
  return { project, column };
}

describe("kart kopyalama", () => {
  it("ayni kolona kopyalayinca etiket ve atananlar tasinir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const label = await prisma.label.create({
      data: { projectId: ws.project.id, name: "Acil", color: "#EF4444" },
    });
    const card = await createCard(ws.todo.id, ws.admin.id, "Orijinal kart");
    await prisma.cardLabel.create({ data: { cardId: card.id, labelId: label.id } });
    await prisma.cardAssignee.create({ data: { cardId: card.id, userId: ws.member.id } });

    const result = await cardService.duplicateCard(card.id, ws.admin.id, {});

    expect(result.card.title).toBe("Orijinal kart (kopya)");
    expect(result.card.columnId).toBe(ws.todo.id);
    expect(result.card.number).not.toBe(card.number);
    expect(result.droppedLabels).toHaveLength(0);
    expect(result.card.assignees.map((a) => a.user.id)).toEqual([ws.member.id]);

    const kopyaninEtiketleri = await prisma.cardLabel.findMany({ where: { cardId: result.card.id } });
    expect(kopyaninEtiketleri.map((l) => l.labelId)).toEqual([label.id]);
  });

  it("baska projeye kopyalarken isim eslesmeyen etiket ve tum ozel alanlar dusurulur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const { project: project2, column: column2 } = await createSecondProject(ws.org.id, ws.admin.id, "IK2");

    const esizLabel = await prisma.label.create({
      data: { projectId: ws.project.id, name: "Bug", color: "#EF4444" },
    });
    const eslesenLabelKaynak = await prisma.label.create({
      data: { projectId: ws.project.id, name: "onemli", color: "#000000" },
    });
    const eslesenLabelHedef = await prisma.label.create({
      data: { projectId: project2.id, name: "ONEMLI", color: "#111111" },
    });
    const field = await prisma.customFieldDefinition.create({
      data: { projectId: ws.project.id, name: "Sprint", type: "TEXT" },
    });

    const card = await createCard(ws.todo.id, ws.admin.id, "Tasinacak kart");
    await prisma.cardLabel.createMany({
      data: [
        { cardId: card.id, labelId: esizLabel.id },
        { cardId: card.id, labelId: eslesenLabelKaynak.id },
      ],
    });
    await prisma.cardCustomFieldValue.create({ data: { cardId: card.id, fieldId: field.id, value: "S3" } });

    const result = await cardService.duplicateCard(card.id, ws.admin.id, { targetColumnId: column2.id });

    expect(result.card.columnId).toBe(column2.id);
    expect(result.droppedLabels).toEqual(["Bug"]);
    expect(result.droppedCustomFields).toEqual(["Sprint"]);

    const kopyaninEtiketleri = await prisma.cardLabel.findMany({ where: { cardId: result.card.id } });
    expect(kopyaninEtiketleri.map((l) => l.labelId)).toEqual([eslesenLabelHedef.id]);

    const kopyaninOzelAlanlari = await prisma.cardCustomFieldValue.findMany({ where: { cardId: result.card.id } });
    expect(kopyaninOzelAlanlari).toHaveLength(0);
  });

  it("yetkisiz kullanici kopyalayamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id, "Kart");

    await expect(cardService.duplicateCard(card.id, ws.member.id, {})).rejects.toThrow(ForbiddenError);
  });
});

describe("karti baska projeye tasima", () => {
  it("kart hedef projeye tasinir, numara yeniden alinir, eslesen etiket korunur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const { project: project2, column: column2 } = await createSecondProject(ws.org.id, ws.admin.id, "IK3");

    const eslesenKaynak = await prisma.label.create({ data: { projectId: ws.project.id, name: "onemli", color: "#000" } });
    const eslesenHedef = await prisma.label.create({ data: { projectId: project2.id, name: "Onemli", color: "#111" } });
    const digerKart = await createCard(column2.id, ws.admin.id, "Hedefteki mevcut kart");

    const card = await createCard(ws.todo.id, ws.admin.id, "Tasinacak kart");
    await prisma.cardLabel.create({ data: { cardId: card.id, labelId: eslesenKaynak.id } });

    const result = await cardService.moveCardToProject(card.id, column2.id, ws.admin.id);

    expect(result.card.columnId).toBe(column2.id);
    expect(result.card.number).not.toBe(card.number);
    expect(result.card.number).toBeGreaterThan(digerKart.number);
    expect(result.droppedLabels).toHaveLength(0);

    const etiketler = await prisma.cardLabel.findMany({ where: { cardId: card.id } });
    expect(etiketler.map((l) => l.labelId)).toEqual([eslesenHedef.id]);
  });

  it("ayni projedeki kolona bu uctan tasinamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id, "Kart");

    await expect(cardService.moveCardToProject(card.id, ws.done.id, ws.admin.id)).rejects.toThrow(ValidationError);
  });

  it("farkli organizasyona tasinamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const org2 = await prisma.organization.create({
      data: {
        name: "Diger Org",
        ownerId: ws.admin.id,
        members: { create: [{ userId: ws.admin.id, role: "ADMIN" }] },
      },
    });
    orgIds.push(org2.id);
    const { column: column2 } = await createSecondProject(org2.id, ws.admin.id, "OTR");

    const card = await createCard(ws.todo.id, ws.admin.id, "Kart");

    await expect(cardService.moveCardToProject(card.id, column2.id, ws.admin.id)).rejects.toThrow(ForbiddenError);
  });

  it("normal uye baska projeye tasiyamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const { column: column2 } = await createSecondProject(ws.org.id, ws.admin.id, "IK4");
    const card = await createCard(ws.todo.id, ws.admin.id, "Kart");

    await expect(cardService.moveCardToProject(card.id, column2.id, ws.member.id)).rejects.toThrow(ForbiddenError);
  });
});
