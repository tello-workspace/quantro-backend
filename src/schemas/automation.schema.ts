import { z } from "zod";

const triggerEnum = z.enum(["CARD_MOVED_TO_COLUMN", "CARD_CREATED"]);
const actionTypeEnum = z.enum(["ADD_LABEL", "MOVE_TO_COLUMN", "ASSIGN_USER", "SEND_NOTIFICATION"]);

export const createAutomationRuleSchema = z
  .object({
    name: z.string().min(1, "Kural adı gerekli").max(100),
    trigger: triggerEnum,
    triggerColumnId: z.string().nullable().optional(),
    actionType: actionTypeEnum,
    actionLabelId: z.string().nullable().optional(),
    actionColumnId: z.string().nullable().optional(),
    actionUserId: z.string().nullable().optional(),
    actionMessage: z.string().max(300).nullable().optional(),
  })
  .refine(
    (v) => v.trigger !== "CARD_MOVED_TO_COLUMN" || !!v.triggerColumnId,
    { message: "Bu tetikleyici için hedef sütun seçilmeli", path: ["triggerColumnId"] },
  )
  .refine((v) => v.actionType !== "ADD_LABEL" || !!v.actionLabelId, {
    message: "Bu aksiyon için etiket seçilmeli",
    path: ["actionLabelId"],
  })
  .refine((v) => v.actionType !== "MOVE_TO_COLUMN" || !!v.actionColumnId, {
    message: "Bu aksiyon için hedef sütun seçilmeli",
    path: ["actionColumnId"],
  })
  .refine((v) => v.actionType !== "ASSIGN_USER" || !!v.actionUserId, {
    message: "Bu aksiyon için kullanıcı seçilmeli",
    path: ["actionUserId"],
  })
  .refine((v) => v.actionType !== "SEND_NOTIFICATION" || (!!v.actionUserId && !!v.actionMessage), {
    message: "Bu aksiyon için kullanıcı ve mesaj gerekli",
    path: ["actionMessage"],
  });

export const updateAutomationRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
