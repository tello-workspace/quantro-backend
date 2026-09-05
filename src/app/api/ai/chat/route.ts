import { NextRequest } from "next/server";
import * as aiService from "@/services/ai.service";
import { successResponse, errorResponse, handleApiError } from "@/utils/api-response";
import { authenticate, AuthenticatedRequest } from "@/middleware/auth";
import { checkAiRateLimit } from "@/middleware/rateLimit";
import { checkProjectAccess } from "@/services/access-control.service";
import { AppError } from "@/utils/errors";
import { z } from "zod";

// Gövde doğrulaması: önceden yalnızca `Array.isArray(messages)` bakılıyordu.
// Bunun üç somut kusuru vardı: (a) content string değilse (örn. sayı)
// ai.service'teki compactOldMessages içinde `content.includes("```")` TypeError
// atıp isteği 500'e düşürüyor ve her denemede bir ErrorLog satırı yazılıyordu,
// (b) "tool" gibi uydurma role değerleri filtreden geçip sağlayıcıdan anlamsız
// bir 400 döndürüyordu, (c) mesaj boyutu hiç sınırlanmadığı için tek istekte
// megabaytlarca metin doğrudan AI sağlayıcısına (ve faturaya) gidebiliyordu.
const MAKS_ICERIK = 4000;
const MAKS_MESAJ = 30;

const aiChatSchema = z.object({
  projectId: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
});

export async function POST(request: NextRequest) {
  const authError = await authenticate(request);
  if (authError) return authError;

  try {
    const user = (request as AuthenticatedRequest).user;

    const rateLimitError = checkAiRateLimit(user.id, "ai:chat");
    if (rateLimitError) return rateLimitError;

    const body = await request.json().catch(() => null);
    const parsed = aiChatSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "projectId ve messages (role: user/assistant, content: metin) gerekli",
        400,
        "VALIDATION_ERROR",
      );
    }

    const { projectId } = parsed.data;

    // Uzun geçmişi/mesajı reddetmek yerine kırpıyoruz: istemci her istekte tüm
    // sohbet geçmişini gönderiyor, sert bir üst sınır uzun konuşmaları kalıcı
    // olarak 400'e düşürüp paneli kullanılamaz hale getirirdi. Servis zaten son
    // 10 mesajı kullanıyor; buradaki kırpma yalnızca sağlayıcıya gidecek token
    // hacmini sınırlıyor (compactOldMessages son 4 mesaja hiç dokunmuyor).
    const messages = parsed.data.messages.slice(-MAKS_MESAJ).map((m) => ({
      ...m,
      content:
        m.content.length > MAKS_ICERIK
          ? m.content.slice(0, MAKS_ICERIK) + "\n\n[...mesaj sunucu tarafında kırpıldı...]"
          : m.content,
    }));

    // Projeye erişim kontrolü: sadece org üyeliği YETMEZ - GUEST/PRIVATE/TEAM
    // görünürlük kuralları REST'teki checkProjectAccess ile birebir uygulanmalı.
    // Önceden burada ham org-üyeliği sorgusu vardı; bu, açıkça eklenmemiş
    // (GUEST) veya PRIVATE bir projenin tüm pano bağlamının (kart başlıkları,
    // atananlar, teslim tarihleri) AI sohbeti üzerinden herhangi bir org
    // üyesine sızmasına yol açıyordu.
    await checkProjectAccess(projectId, user.id);

    const reply = await aiService.sendMessage(projectId, user.id, messages);
    return successResponse({ reply });
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.message, error.statusCode, error.code);
    }
    return handleApiError(request, error, "AI mesajı gönderilemedi");
  }
}
