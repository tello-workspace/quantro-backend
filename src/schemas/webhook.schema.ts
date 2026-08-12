import { z } from "zod";

const WEBHOOK_EVENTS = ["CARD_CREATED", "CARD_MOVED", "CARD_ASSIGNED", "CARD_COMMENTED", "CHANGE_REQUEST_APPROVED"] as const;

export const createWebhookSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "En az bir olay seçilmelidir"),
});

export const updateWebhookSchema = z.object({
  url: z.string().url().max(500).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  isActive: z.boolean().optional(),
});

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
