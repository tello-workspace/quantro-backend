import { z } from "zod";

const triggerEnum = z.enum(["CARD_MOVED_TO_COLUMN", "CARD_CREATED", "SCHEDULED", "CARD_DUE_SOON"]);
const actionTypeEnum = z.enum([
  "ADD_LABEL",
  "MOVE_TO_COLUMN",
  "ASSIGN_USER",
  "SEND_NOTIFICATION",
  "CREATE_CARD",
]);

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
    // SCHEDULED: 0=Pazar..6=Cumartesi, null/undefined = her gun
    scheduleDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    // CARD_DUE_SOON: teslim tarihine kac gun kala tetiklenecegi
    dueSoonDays: z.number().int().min(0).max(90).nullable().optional(),
    // Kosul filtreleri: null/undefined = filtre yok
    conditionPriority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).nullable().optional(),
    conditionLabelId: z.string().nullable().optional(),
    // Kart detayindan "bunu tekrarla" ile olusturulduysa kaynak kart id'si
    sourceCardId: z.string().nullable().optional(),
  })
  .refine(
    (v) => v.trigger !== "CARD_MOVED_TO_COLUMN" || !!v.triggerColumnId,
    { message: "Bu tetikleyici için hedef sütun seçilmeli", path: ["triggerColumnId"] },
  )
  .refine((v) => v.trigger !== "CARD_DUE_SOON" || v.dueSoonDays != null, {
    message: "Bu tetikleyici için gün sayısı seçilmeli",
    path: ["dueSoonDays"],
  })
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
  })
  .refine((v) => v.actionType !== "CREATE_CARD" || (!!v.actionColumnId && !!v.actionMessage), {
    message: "Bu aksiyon için hedef sütun ve kart başlığı gerekli",
    path: ["actionColumnId"],
  })
  // Motor tarafinda CREATE_CARD ile SCHEDULED birbirine bagli: executeAction'in
  // (automation.service.ts) switch'inde CREATE_CARD case'i YOK, executeCreateCardAction
  // ise yalnizca SCHEDULED dongusunden cagriliyor ve diger aksiyonlari eliyor.
  // Bu iki kombinasyon disindaki eslesmeler 201 ile olusup listede isActive=true
  // gorunuyor ama HICBIR ZAMAN calismiyor, tek bir hata log'u bile dusmuyor.
  // Uyumsuzlugu kural kurulurken reddediyoruz ki sessiz basarisizlik olmasin.
  .refine((v) => v.actionType !== "CREATE_CARD" || v.trigger === "SCHEDULED", {
    message: "Kart oluşturma aksiyonu yalnızca zamanlanmış tetikleyiciyle kullanılabilir",
    path: ["actionType"],
  })
  .refine((v) => v.trigger !== "SCHEDULED" || v.actionType === "CREATE_CARD", {
    message: "Zamanlanmış tetikleyici yalnızca kart oluşturma aksiyonunu destekler",
    path: ["actionType"],
  });

export const updateAutomationRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
