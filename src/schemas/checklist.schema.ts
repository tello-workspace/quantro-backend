import { z } from "zod";

export const createChecklistItemSchema = z.object({
  text: z.string().min(1, "Madde boş olamaz").max(300, "Madde çok uzun"),
});

export const updateChecklistItemSchema = z.object({
  text: z.string().min(1, "Madde boş olamaz").max(300, "Madde çok uzun").optional(),
  done: z.boolean().optional(),
  position: z.number().optional(),
});

export type CreateChecklistItemInput = z.infer<typeof createChecklistItemSchema>;
export type UpdateChecklistItemInput = z.infer<typeof updateChecklistItemSchema>;
