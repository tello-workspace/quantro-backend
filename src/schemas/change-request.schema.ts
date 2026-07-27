import { z } from "zod";

// Uyenin doldurdugu kart icerigi.
const cardPayloadSchema = z.object({
  title: z.string().min(1, "Başlık boş olamaz").max(200, "Başlık çok uzun").optional(),
  description: z.string().max(5000, "Açıklama çok uzun").nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  dueDate: z.string().nullable().optional(),
  assigneeIds: z.array(z.string()).optional(),
});

export const createChangeRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CARD_CREATE"),
    targetColumnId: z.string().min(1, "Kolon seçilmeli"),
    payload: cardPayloadSchema.extend({
      title: z.string().min(1, "Başlık boş olamaz").max(200, "Başlık çok uzun"),
    }),
  }),
  z.object({
    type: z.literal("CARD_UPDATE"),
    targetCardId: z.string().min(1, "Kart seçilmeli"),
    payload: cardPayloadSchema.refine(
      (p) => Object.keys(p).length > 0,
      "En az bir alan değişmeli",
    ),
  }),
  z.object({
    type: z.literal("CARD_DELETE"),
    targetCardId: z.string().min(1, "Kart seçilmeli"),
    // .default() kullanilmadi: zod'un girdi/cikti tipleri ayrisip
    // discriminated union'da tip uyumsuzluguna yol aciyordu
    payload: z.object({ reason: z.string().max(500).optional() }).optional(),
  }),
  z.object({
    type: z.literal("COLUMN_CREATE"),
    projectId: z.string().min(1, "Proje seçilmeli"),
    payload: z.object({
      name: z.string().min(1, "Sütun adı boş olamaz").max(100),
      wipLimit: z.number().int().positive().nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("PROJECT_CREATE"),
    payload: z.object({
      name: z.string().min(1, "Proje adı boş olamaz").max(100),
      description: z.string().max(1000).nullable().optional(),
    }),
  }),
]);

export const reviewChangeRequestSchema = z.object({
  note: z.string().max(500, "Not çok uzun").optional(),
  payload: z.any().optional(),
});

export const listChangeRequestsSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type ReviewChangeRequestInput = z.infer<typeof reviewChangeRequestSchema>;
export type ListChangeRequestsInput = z.infer<typeof listChangeRequestsSchema>;
