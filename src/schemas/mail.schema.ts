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
});

export const updateDraftSchema = composeMailSchema.partial().extend({
  send: z.boolean().optional(),
});

export const mailFolderSchema = z.enum(["inbox", "sent", "drafts"]);

export type ComposeMailInput = z.infer<typeof composeMailSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
export type RecipientGroup = z.infer<typeof recipientGroupSchema>;
