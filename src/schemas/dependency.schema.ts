import { z } from "zod";

export const createDependencySchema = z.object({
  blockerId: z.string().min(1, "blockerId zorunludur"),
});

export type CreateDependencyInput = z.infer<typeof createDependencySchema>;
