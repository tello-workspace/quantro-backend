import { z } from "zod";

const recipientGroupSchema = z.union([
  z.object({ type: z.literal("ORGANIZATION") }),
  z.object({ type: z.literal("ADMINS") }),
  z.object({ type: z.literal("PROJECT"), projectId: z.string() }),
]);

export const composeMailSchema = z.object({
  subject: z.string().trim().min(1, "Konu gerekli").max(200),
  body: z.string().min(1, "Mesaj gerekli").max(10_000),
  recipientUserIds: z.array(z.string()).max(500).default([]),
  recipientGroups: z.array(recipientGroupSchema).max(20).default([]),
  isDraft: z.boolean().default(false),
  // Yanit taslagi olarak kaydedilen mesajin hangi mesaja bagli oldugu.
  // Dogrudan compose ile de gonderilebilir; servis zinciri kurar.
  parentMailId: z.string().optional(),
});

export const updateDraftSchema = composeMailSchema.partial().extend({
  send: z.boolean().optional(),
});

export const mailFolderSchema = z.enum(["inbox", "sent", "drafts"]);

// REPLY: yalnizca gonderene. REPLY_ALL: gonderen + diger tum alicilar
// (kendim haric). FORWARD: alici listesi sifirdan secilir, gecmis alicilar
// tasinmaz - iletme yeni bir kitleye acmaktir.
export const mailReplyModeSchema = z.enum(["REPLY", "REPLY_ALL", "FORWARD"]);

export const replyMailSchema = z.object({
  mode: mailReplyModeSchema,
  body: z.string().min(1, "Mesaj gerekli").max(10_000),
  // Yalnizca FORWARD icin anlamli; REPLY/REPLY_ALL'da alicilar kaynak
  // mesajdan turetilir ve bu alanlar yok sayilir.
  recipientUserIds: z.array(z.string()).max(500).default([]),
  recipientGroups: z.array(recipientGroupSchema).max(20).default([]),
  isDraft: z.boolean().default(false),
});

export type ComposeMailInput = z.infer<typeof composeMailSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type RecipientGroup = z.infer<typeof recipientGroupSchema>;
export type MailReplyMode = z.infer<typeof mailReplyModeSchema>;
export type ReplyMailInput = z.infer<typeof replyMailSchema>;
