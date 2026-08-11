import { z } from "zod";

export const createCommentSchema = z.object({
  text: z.string().min(1, "Yorum boş olamaz").max(1000, "Yorum çok uzun"),
  // Verilirse yanit olur. Sinirsiz ic ice yorumu onlemek icin serviste
  // hedef her zaman KOK yoruma normallestirilir (bir yanita yanit verilirse
  // otomatik olarak o yanitin kok yorumuna baglanir).
  parentCommentId: z.string().optional(),
});

export const updateCommentSchema = z.object({
  text: z.string().min(1, "Yorum boş olamaz").max(1000, "Yorum çok uzun"),
});

export const toggleReactionSchema = z.object({
  emoji: z.string().min(1).max(8),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
export type ToggleReactionInput = z.infer<typeof toggleReactionSchema>;
