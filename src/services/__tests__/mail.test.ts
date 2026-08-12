import { describe, it, expect, afterAll } from "vitest";
import * as mailService from "@/services/mail.service";
import { ForbiddenError, ValidationError } from "@/utils/errors";
import { createWorkspace, cleanup } from "@/test/fixtures";

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
