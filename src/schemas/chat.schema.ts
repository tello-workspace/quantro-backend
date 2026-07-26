import { z } from "zod";

export const createChatMessageSchema = z.object({
  text: z.string().min(1, "Mesaj boş olamaz").max(2000, "Mesaj çok uzun"),
});

export const listChatMessagesSchema = z.object({
  // Sonsuz kaydirma icin: bu id'den onceki mesajlar getirilir
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateChatMessageInput = z.infer<typeof createChatMessageSchema>;
export type ListChatMessagesInput = z.infer<typeof listChatMessagesSchema>;
