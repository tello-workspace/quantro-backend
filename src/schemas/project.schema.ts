import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1, "Proje adı zorunludur").max(100),
  description: z.string().max(500).optional(),
  // Kart anahtarı öneki ("QNT" -> QNT-42). Verilmezse proje adından
  // üretilir; doluysa sonuna sayı eklenerek boş olan ilk anahtar alınır.
  key: z.string().min(2).max(5).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
