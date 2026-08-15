import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import * as mailService from "@/services/mail.service";
import { ForbiddenError, ValidationError } from "@/utils/errors";
import { createWorkspace, createUser, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

describe("mail - gönderim", () => {
  it("tekil alıcıya gönderilen mesaj karşı tarafın gelen kutusunda görünür", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const mail = await mailService.composeMail(
      ws.org.id,
      { subject: "Merhaba", body: "Test mesajı", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );
    expect(mail.isDraft).toBe(false);
    expect(mail.sentAt).not.toBeNull();

    const inbox = await mailService.listMail(ws.org.id, ws.member.id, "inbox");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].id).toBe(mail.id);
    expect((inbox[0] as any).read).toBe(false);

    const sent = await mailService.listMail(ws.org.id, ws.admin.id, "sent");
    expect(sent).toHaveLength(1);

    const unread = await mailService.getUnreadMailCount(ws.org.id, ws.member.id);
    expect(unread).toBe(1);
  }, 60000);

  it("ORGANIZATION grubu gönderen hariç tüm üyelere gider, org dışı biri hariç tutulur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const mail = await mailService.composeMail(
      ws.org.id,
      { subject: "Duyuru", body: "Herkese", recipientUserIds: [], recipientGroups: [{ type: "ORGANIZATION" }], isDraft: false },
      ws.admin.id,
    );

    const detay = await mailService.getMail(mail.id, ws.admin.id);
    const aliciIdler = detay.recipients.map((r) => r.userId).sort();
    expect(aliciIdler).toEqual([ws.member.id].sort());

    await expect(mailService.getMail(mail.id, ws.outsider.id)).rejects.toThrow(ForbiddenError);
  }, 60000);

  it("mesajı okumak okunmamış sayısını düşürür", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const mail = await mailService.composeMail(
      ws.org.id,
      { subject: "Konu", body: "Gövde", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    expect(await mailService.getUnreadMailCount(ws.org.id, ws.member.id)).toBe(1);
    await mailService.getMail(mail.id, ws.member.id);
    expect(await mailService.getUnreadMailCount(ws.org.id, ws.member.id)).toBe(0);
  }, 60000);
});

describe("mail - taslak", () => {
  it("taslak alıcı gelen kutusunda görünmez, gönderilince görünür", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const taslak = await mailService.composeMail(
      ws.org.id,
      { subject: "Taslak", body: "Henüz gönderilmedi", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: true },
      ws.admin.id,
    );
    expect(taslak.isDraft).toBe(true);

    expect(await mailService.listMail(ws.org.id, ws.member.id, "inbox")).toHaveLength(0);
    expect(await mailService.listMail(ws.org.id, ws.admin.id, "drafts")).toHaveLength(1);

    const gonderilen = await mailService.updateDraft(taslak.id, { send: true }, ws.admin.id);
    expect(gonderilen.isDraft).toBe(false);

    expect(await mailService.listMail(ws.org.id, ws.member.id, "inbox")).toHaveLength(1);
    expect(await mailService.listMail(ws.org.id, ws.admin.id, "drafts")).toHaveLength(0);
  }, 60000);

  it("alıcısız taslak gönderilemez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const taslak = await mailService.composeMail(
      ws.org.id,
      { subject: "Boş", body: "Kimseye gitmiyor", recipientUserIds: [], recipientGroups: [], isDraft: true },
      ws.admin.id,
    );

    await expect(mailService.updateDraft(taslak.id, { send: true }, ws.admin.id)).rejects.toThrow(ValidationError);
  }, 60000);

  it("başkasının taslağı düzenlenemez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const taslak = await mailService.composeMail(
      ws.org.id,
      { subject: "Özel", body: "Sadece benim", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: true },
      ws.admin.id,
    );

    await expect(mailService.updateDraft(taslak.id, { subject: "Değişti" }, ws.member.id)).rejects.toThrow(ForbiddenError);
  }, 60000);

  it("taslak silinince gerçekten kaybolur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const taslak = await mailService.composeMail(
      ws.org.id,
      { subject: "Silinecek", body: "...", recipientUserIds: [], recipientGroups: [], isDraft: true },
      ws.admin.id,
    );

    const sonuc = await mailService.deleteMail(taslak.id, ws.admin.id);
    expect(sonuc.deleted).toBe("draft");
    await expect(mailService.getMail(taslak.id, ws.admin.id)).rejects.toThrow();
  }, 60000);
});

describe("mail - yanıtlama ve iletme", () => {
  it("REPLY yalnızca gönderene gider, konu Yn: ile öneklenir ve gövde alıntılanır", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const asil = await mailService.composeMail(
      ws.org.id,
      { subject: "Toplantı", body: "Yarın 10:00", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    const yanit = await mailService.replyToMail(
      asil.id,
      { mode: "REPLY", body: "Uygun", recipientUserIds: [], recipientGroups: [], isDraft: false },
      ws.member.id,
    );

    expect(yanit.subject).toBe("Yn: Toplantı");
    expect(yanit.body).toContain("Uygun");
    expect(yanit.body).toContain("> Yarın 10:00");
    expect(yanit.parentMailId).toBe(asil.id);
    expect(yanit.threadId).toBe(asil.id);

    const detay = await mailService.getMail(yanit.id, ws.member.id);
    expect(detay.recipients.map((r) => r.userId)).toEqual([ws.admin.id]);
  }, 60000);

  it("REPLY_ALL gönderen ve diğer alıcılara gider, yanıtlayan kendisi hariç tutulur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const ucuncu = await createUser("Third User");
    userIds.push(ucuncu.id);
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: ucuncu.id, role: "MEMBER" },
    });

    const asil = await mailService.composeMail(
      ws.org.id,
      {
        subject: "Duyuru",
        body: "Herkese",
        recipientUserIds: [ws.member.id, ucuncu.id],
        recipientGroups: [],
        isDraft: false,
      },
      ws.admin.id,
    );

    const yanit = await mailService.replyToMail(
      asil.id,
      { mode: "REPLY_ALL", body: "Okudum", recipientUserIds: [], recipientGroups: [], isDraft: false },
      ws.member.id,
    );

    const detay = await mailService.getMail(yanit.id, ws.member.id);
    const alicilar = detay.recipients.map((r) => r.userId).sort();
    expect(alicilar).toEqual([ws.admin.id, ucuncu.id].sort());
    expect(alicilar).not.toContain(ws.member.id);
  }, 60000);

  it("FORWARD eski alıcıları taşımaz, yalnızca seçilen yeni alıcıya gider", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const ucuncu = await createUser("Third User");
    userIds.push(ucuncu.id);
    await prisma.organizationMember.create({
      data: { organizationId: ws.org.id, userId: ucuncu.id, role: "MEMBER" },
    });

    const asil = await mailService.composeMail(
      ws.org.id,
      { subject: "Rapor", body: "Ekte", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    const iletilen = await mailService.replyToMail(
      asil.id,
      { mode: "FORWARD", body: "Bilgine", recipientUserIds: [ucuncu.id], recipientGroups: [], isDraft: false },
      ws.member.id,
    );

    expect(iletilen.subject).toBe("İlt: Rapor");
    const detay = await mailService.getMail(iletilen.id, ws.member.id);
    expect(detay.recipients.map((r) => r.userId)).toEqual([ucuncu.id]);
  }, 60000);

  it("yanıta yanıt aynı thread'de kalır ve konu tekrar öneklenmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const asil = await mailService.composeMail(
      ws.org.id,
      { subject: "Konu", body: "Bir", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    const yanit1 = await mailService.replyToMail(
      asil.id,
      { mode: "REPLY", body: "İki", recipientUserIds: [], recipientGroups: [], isDraft: false },
      ws.member.id,
    );
    const yanit2 = await mailService.replyToMail(
      yanit1.id,
      { mode: "REPLY", body: "Üç", recipientUserIds: [], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    expect(yanit2.subject).toBe("Yn: Konu");
    expect(yanit1.threadId).toBe(asil.id);
    expect(yanit2.threadId).toBe(asil.id);
    expect(yanit2.parentMailId).toBe(yanit1.id);

    // Konusma gecmisi: asil mesaji acan admin, kendi gonderdigi kok ve
    // yanit2 ile alicisi oldugu yanit1'i gorur.
    const detay = await mailService.getMail(asil.id, ws.admin.id);
    expect(detay.thread.map((m) => m.id).sort()).toEqual([yanit1.id, yanit2.id].sort());
  }, 60000);

  it("mesaja erişimi olmayan biri onu yanıtlayamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const asil = await mailService.composeMail(
      ws.org.id,
      { subject: "Özel", body: "Gizli", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    await expect(
      mailService.replyToMail(
        asil.id,
        { mode: "REPLY", body: "Araya girdim", recipientUserIds: [], recipientGroups: [], isDraft: false },
        ws.outsider.id,
      ),
    ).rejects.toThrow(ForbiddenError);
  }, 60000);

  it("taslak bir mesaj yanıtlanamaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const taslak = await mailService.composeMail(
      ws.org.id,
      { subject: "Taslak", body: "...", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: true },
      ws.admin.id,
    );

    await expect(
      mailService.replyToMail(
        taslak.id,
        { mode: "REPLY", body: "Olmaz", recipientUserIds: [], recipientGroups: [], isDraft: false },
        ws.admin.id,
      ),
    ).rejects.toThrow(ValidationError);
  }, 60000);

  it("yanıt taslak olarak kaydedilebilir, gönderilene kadar gelen kutusuna düşmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const asil = await mailService.composeMail(
      ws.org.id,
      { subject: "Soru", body: "Ne zaman?", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    const taslakYanit = await mailService.replyToMail(
      asil.id,
      { mode: "REPLY", body: "Düşünüyorum", recipientUserIds: [], recipientGroups: [], isDraft: true },
      ws.member.id,
    );

    expect(taslakYanit.isDraft).toBe(true);
    expect(taslakYanit.threadId).toBe(asil.id);
    expect(await mailService.listMail(ws.org.id, ws.member.id, "drafts")).toHaveLength(1);

    const gonderilen = await mailService.updateDraft(taslakYanit.id, { send: true }, ws.member.id);
    expect(gonderilen.isDraft).toBe(false);
    expect(gonderilen.threadId).toBe(asil.id);
  }, 60000);
});

describe("mail - gelen kutusundan silme", () => {
  it("alıcı kendi gelen kutusundan silince gönderenin Gönderilenler'i etkilenmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const mail = await mailService.composeMail(
      ws.org.id,
      { subject: "Konu", body: "Gövde", recipientUserIds: [ws.member.id], recipientGroups: [], isDraft: false },
      ws.admin.id,
    );

    const sonuc = await mailService.deleteMail(mail.id, ws.member.id);
    expect(sonuc.deleted).toBe("inbox");

    expect(await mailService.listMail(ws.org.id, ws.member.id, "inbox")).toHaveLength(0);
    expect(await mailService.listMail(ws.org.id, ws.admin.id, "sent")).toHaveLength(1);
  }, 60000);
});
