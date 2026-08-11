import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().min(1, "Organizasyon adı zorunludur").max(100),
  description: z.string().max(500).optional(),
});

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

export const addMemberSchema = z.object({
  email: z.string().email("Geçerli bir email adresi giriniz"),
  // GUEST: yalnizca davet edildigi proje(ler)i gorecek kisi (musteri/stajyer).
  role: z.enum(["ADMIN", "MEMBER", "GUEST"]).optional(),
});

export const updateMemberRoleSchema = z.object({
  userId: z.string(),
  role: z.enum(["ADMIN", "MEMBER", "GUEST"]),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

// ─── Badge / Rozet ────────────────────────────────────────────────────

export const createBadgeSchema = z.object({
  name: z.string().min(1, "Rozet adı zorunlu").max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Geçerli bir hex renk girin (örn: #3B82F6)"),
  icon: z.string().max(1000000).optional(),
});

export const assignBadgeSchema = z.object({
  userId: z.string(),
  badgeId: z.string(),
});

export type CreateBadgeInput = z.infer<typeof createBadgeSchema>;
export type AssignBadgeInput = z.infer<typeof assignBadgeSchema>;
