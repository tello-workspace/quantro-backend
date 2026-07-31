import { z } from "zod";

export const createCustomFieldSchema = z.object({
  name: z.string().min(1, "Alan adı gerekli").max(60),
  type: z.enum(["TEXT", "NUMBER", "DATE", "SELECT", "CHECKBOX"]),
  options: z.array(z.string().min(1).max(60)).max(50).optional(),
});

export const updateCustomFieldValueSchema = z.object({
  value: z.string().max(2000).nullable(),
});

export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldValueInput = z.infer<typeof updateCustomFieldValueSchema>;
