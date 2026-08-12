import { describe, it, expect, afterAll } from "vitest";
import * as commentService from "@/services/comment.service";
import { ValidationError } from "@/utils/errors";
import { createWorkspace, createCard, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

describe("yorum sistemi - thread", () => {
  // 60000ms: 3 ardisik createComment cagrisi, her biri artik webhook
  // dispatchEvent() icin ek bir sorgu tetikliyor - transaction-mode pooler
  // altinda bu ek round-trip'ler varsayilan 30000ms'i asabiliyor (bkz.
  // bulk-card.test.ts'teki ayni sinif gecikme).
  it("yanit kok yoruma baglanir, yanita yanit da otomatik olarak ayni koke baglanir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    const kok = await commentService.createComment(card.id, { text: "Kok yorum" }, ws.admin.id);
    const yanit1 = await commentService.createComment(
      card.id,
      { text: "Ilk yanit", parentCommentId: kok.id },
      ws.member.id,
    );
    // Yanita yanit vermeye calisiliyor - sinirsiz ic ice yorum olmamali,
    // otomatik olarak kok yoruma (kok.id) baglanmali.
    const yanit2 = await commentService.createComment(
      card.id,
      { text: "Yanita yanit", parentCommentId: yanit1.id },
      ws.admin.id,
    );

    expect(yanit1.parentCommentId).toBe(kok.id);
    expect(yanit2.parentCommentId).toBe(kok.id);

    const liste = await commentService.getComments(card.id, ws.admin.id);
    expect(liste).toHaveLength(1);
    expect(liste[0].id).toBe(kok.id);
    expect(liste[0].replies.map((r) => r.id).sort()).toEqual([yanit1.id, yanit2.id].sort());
  }, 60000);

  it("kok yorum silinince yanitlari da silinir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    const kok = await commentService.createComment(card.id, { text: "Kok" }, ws.admin.id);
    await commentService.createComment(card.id, { text: "Yanit", parentCommentId: kok.id }, ws.member.id);

    await commentService.deleteComment(kok.id, ws.admin.id);

    const liste = await commentService.getComments(card.id, ws.admin.id);
    expect(liste).toHaveLength(0);
  });
});

describe("yorum sistemi - duzenleme izi", () => {
  it("guncellenince editedAt dolar", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    const yorum = await commentService.createComment(card.id, { text: "Ilk hali" }, ws.admin.id);
    expect(yorum.editedAt).toBeNull();

    const guncel = await commentService.updateComment(yorum.id, { text: "Duzeltilmis hali" }, ws.admin.id);
    expect(guncel.editedAt).not.toBeNull();
  });
});

describe("yorum sistemi - cozuldu isareti", () => {
  it("yazar disindaki biri kok yorumu cozuldu isaretleyip acabilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    const kok = await commentService.createComment(card.id, { text: "Tartisma" }, ws.admin.id);
    const cozulmus = await commentService.resolveComment(kok.id, ws.member.id, true);
    expect(cozulmus.resolvedAt).not.toBeNull();
    expect(cozulmus.resolvedBy?.id).toBe(ws.member.id);

    const acilmis = await commentService.resolveComment(kok.id, ws.admin.id, false);
    expect(acilmis.resolvedAt).toBeNull();
  });

  it("bir yanit tek basina cozuldu isaretlenemez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);

    const kok = await commentService.createComment(card.id, { text: "Kok" }, ws.admin.id);
    const yanit = await commentService.createComment(card.id, { text: "Yanit", parentCommentId: kok.id }, ws.member.id);

    await expect(commentService.resolveComment(yanit.id, ws.admin.id, true)).rejects.toThrow(ValidationError);
  });
});

describe("yorum sistemi - reaksiyonlar", () => {
  it("ayni emoji ile ikinci tiklama reaksiyonu kaldirir (toggle)", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);
    const yorum = await commentService.createComment(card.id, { text: "Emoji testi" }, ws.admin.id);

    const sonra1 = await commentService.toggleReaction(yorum.id, ws.member.id, "👍");
    expect(sonra1).toEqual([{ userId: ws.member.id, emoji: "👍" }]);

    const sonra2 = await commentService.toggleReaction(yorum.id, ws.member.id, "👍");
    expect(sonra2).toHaveLength(0);
  });

  it("farkli kullanicilar ayni yoruma farkli emojilerle reaksiyon verebilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);
    const card = await createCard(ws.todo.id, ws.admin.id);
    const yorum = await commentService.createComment(card.id, { text: "Emoji testi 2" }, ws.admin.id);

    await commentService.toggleReaction(yorum.id, ws.admin.id, "🎉");
    const sonuc = await commentService.toggleReaction(yorum.id, ws.member.id, "👍");

    expect(sonuc.sort((a, b) => a.emoji.localeCompare(b.emoji))).toEqual(
      [
        { userId: ws.admin.id, emoji: "🎉" },
        { userId: ws.member.id, emoji: "👍" },
      ].sort((a, b) => a.emoji.localeCompare(b.emoji)),
    );
  });
});
