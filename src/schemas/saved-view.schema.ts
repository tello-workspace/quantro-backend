import { z } from "zod";

// BoardFilters.tsx'teki filtre state'iyle birebir - yeni bir filtre turu
// eklenirse burada da eklenmesi gerekir ama gecmis kayitlari bozmaz (hepsi
// optional). Bilinmeyen ek alanlar passthrough ile atilmiyor - ileride
// frontend yeni bir alan eklerse backend hemen guncellenmeden de veri kaybi
// olmaz.
// passthrough bilinmeyen alanlari korudugu icin bilinen alanlarin max()
// sinirlari toplam boyutu hic sinirlamiyordu: filters'a megabaytlarca rastgele
// JSON konup isShared:true ile kaydedilebiliyor, sonrasinda panoyu acan HERKES
// bu veriyi indiriyordu. Ileri uyumluluk bozulmasin diye passthrough kaliyor,
// yalnizca serilestirilmis toplam boyuta tavan koyuyoruz.
const FILTERS_MAX_BYTES = 8000;

const filtersSchema = z
  .object({
    search: z.string().max(200).optional(),
    priorities: z.array(z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])).max(4).optional(),
    assigneeIds: z.array(z.string()).max(200).optional(),
    labelIds: z.array(z.string()).max(200).optional(),
  })
  .passthrough()
  .superRefine((filters, ctx) => {
    let boyut: number;
    try {
      boyut = JSON.stringify(filters).length;
    } catch {
      // Dairesel referans vb. serilestirilemeyen govde - dogrudan reddet.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Filtreler işlenemedi" });
      return;
    }
    if (boyut > FILTERS_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Filtreler çok büyük (en fazla ${FILTERS_MAX_BYTES} karakter)`,
      });
    }
  });

export const createSavedViewSchema = z.object({
  name: z.string().min(1, "Görünüm adı zorunludur").max(60),
  filters: filtersSchema,
  isShared: z.boolean().optional(),
});

export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
