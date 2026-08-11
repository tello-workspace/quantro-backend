import { z } from "zod";

// BoardFilters.tsx'teki filtre state'iyle birebir - yeni bir filtre turu
// eklenirse burada da eklenmesi gerekir ama gecmis kayitlari bozmaz (hepsi
// optional). Bilinmeyen ek alanlar passthrough ile atilmiyor - ileride
// frontend yeni bir alan eklerse backend hemen guncellenmeden de veri kaybi
// olmaz.
const filtersSchema = z
  .object({
    search: z.string().max(200).optional(),
    priorities: z.array(z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])).max(4).optional(),
    assigneeIds: z.array(z.string()).max(200).optional(),
    labelIds: z.array(z.string()).max(200).optional(),
  })
  .passthrough();

export const createSavedViewSchema = z.object({
  name: z.string().min(1, "Görünüm adı zorunludur").max(60),
  filters: filtersSchema,
  isShared: z.boolean().optional(),
});

export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
