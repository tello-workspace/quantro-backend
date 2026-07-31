import { z } from "zod";

export const relationTypeEnum = z.enum(["BLOCKS", "RELATES_TO", "DUPLICATES", "CLONES"]);

export const createDependencySchema = z.object({
  blockerId: z.string().min(1, "blockerId zorunludur"),
  relationType: relationTypeEnum.default("BLOCKS"),
});

export type CreateDependencyInput = z.infer<typeof createDependencySchema>;
