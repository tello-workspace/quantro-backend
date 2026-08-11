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
  // Efor tahmini birimi - kolon basliginda ve is yuku raporunda "puan" mi
  // "saat" mi yazacagini belirler. Karti degil, projeyi tercih eder.
  estimateUnit: z.enum(["POINTS", "HOURS"]).optional(),
});

export const updateVisibilitySchema = z.object({
  visibility: z.enum(["ORG", "TEAM", "PRIVATE"]),
});

export const addProjectMemberSchema = z.object({
  userId: z.string().min(1, "Kullanıcı zorunludur"),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type UpdateVisibilityInput = z.infer<typeof updateVisibilitySchema>;
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;
