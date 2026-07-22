import { z } from "zod";

export const createCardSchema = z.object({
  title: z.string().min(1, "Kart başlığı zorunludur").max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeIds: z.array(z.string()).optional(),
  dueDate: z.string().nullable().optional(),
  position: z.number().optional(),
});

export const updateCardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeIds: z.array(z.string()).optional(),
  dueDate: z.string().nullable().optional(),
  columnId: z.string().optional(),
  position: z.number().optional(),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
