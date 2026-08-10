import { z } from "zod";

export const createCardSchema = z.object({
  title: z.string().min(1, "Kart başlığı zorunludur").max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeIds: z.array(z.string()).optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  position: z.number().optional(),
  parentCardId: z.string().nullable().optional(),
});

export const updateCardSchema = z.object({
  // Ust sinir burada BILEREK gevsek (asiri buyuk govdeye karsi bir emniyet
  // supabi). Gercek 200 karakter kurali servis katmaninda ve yalnizca baslik
  // GERCEKTEN degistiginde uygulaniyor.
  //
  // Sebep: AI ve otomasyon cardService.createCard'i dogrudan cagirip route
  // semasini atliyordu, boylece 200'u asan basliklar veritabanina girdi. O
  // kartlarda her PATCH burada oluyordu - arayuz her kaydetmede degismemis
  // basligi da geri gonderdigi icin kart kalici olarak duzenlenemez hale
  // geliyordu (atama, tasima, aciklama - hicbiri kaydedilemiyordu).
  title: z.string().min(1).max(5000).optional(),
  description: z.string().max(2000).nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeIds: z.array(z.string()).optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  columnId: z.string().optional(),
  position: z.number().optional(),
  parentCardId: z.string().nullable().optional(),
});

export const duplicateCardSchema = z.object({
  targetColumnId: z.string().optional(),
  includeLabels: z.boolean().optional(),
  includeAssignees: z.boolean().optional(),
  includeChecklist: z.boolean().optional(),
  includeAttachments: z.boolean().optional(),
  includeCustomFields: z.boolean().optional(),
});

export const moveCardToProjectSchema = z.object({
  targetColumnId: z.string().min(1, "Hedef kolon zorunludur"),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type DuplicateCardInput = z.infer<typeof duplicateCardSchema>;
export type MoveCardToProjectInput = z.infer<typeof moveCardToProjectSchema>;
