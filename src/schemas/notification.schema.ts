import { z } from "zod";

export const markReadSchema = z.object({
  read: z.literal(true),
});

// limit/cursor: liste sabit 50 kayitla kapali kaldigi icin eski bildirimlere
// erisilemiyordu; sayfalama parametreleri uc tarafinda da tanimlanir.
export const getNotificationsQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
