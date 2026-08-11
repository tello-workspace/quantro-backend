import { z } from "zod";

export const createTimeLogSchema = z.object({
  minutes: z.number().int().min(1, "En az 1 dakika girin").max(1440, "Tek kayıtta en fazla 24 saat (1440 dk) girilebilir"),
  note: z.string().max(280).optional(),
  // Verilmezse "simdi" - gecmise donuk giris icin (orn. "dun calistim") verilebilir.
  loggedAt: z.string().optional(),
});

export type CreateTimeLogInput = z.infer<typeof createTimeLogSchema>;
