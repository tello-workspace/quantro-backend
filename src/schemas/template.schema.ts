import { z } from "zod";

export const createTemplateSchema = z.object({
  name: z.string().min(1, "Şablon adı gerekli").max(100),
  title: z.string().min(1, "Kart başlığı gerekli").max(200),
  description: z.string().max(2000).nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  storyPoints: z.number().int().min(0).max(999).nullable().optional(),
  checklistItems: z.array(z.string().min(1).max(300)).max(50).optional(),
});

export const createTemplateFromCardSchema = z.object({
  name: z.string().min(1, "Şablon adı gerekli").max(100),
});

export const createCardFromTemplateSchema = z.object({
  columnId: z.string().min(1, "Sütun seçilmeli"),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type CreateTemplateFromCardInput = z.infer<typeof createTemplateFromCardSchema>;
export type CreateCardFromTemplateInput = z.infer<typeof createCardFromTemplateSchema>;
