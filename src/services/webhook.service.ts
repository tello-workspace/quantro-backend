import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { checkProjectAccess } from "@/services/access-control.service";
import { guvenliWebhookUrlDogrula, WebhookGuvenlikHatasi } from "@/utils/webhook-security";
import type { CreateWebhookInput, UpdateWebhookInput } from "@/schemas/webhook.schema";
import type { WebhookEvent, Prisma } from "@prisma/client";

const MAX_DENEME = 4; // ilk + 3 tekrar
const GERI_CEKILME_MS = [1000, 5000, 30000]; // her tekrar arasi bekleme
const MAX_YANIT_BOYUTU = 1_000_000; // govdeyi hic okumuyoruz ama sinirsiz buyuklukte acik body akisi birakmayalim

function yeniSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

function imzala(govde: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(govde).digest("hex");
}

// Olayi insan-okunur tek satira cevirir - Slack/Discord "text"/"content"
// alanina bu gider. Alan eksikse sessizce atlanir (dispatchEvent'teki
// payload sekilleri sabit olsa da burada gevsek tip guvenli).
function mesajUret(event: WebhookEvent, payload: Record<string, unknown>): string {
  const baslik = typeof payload.title === "string" ? payload.title : "(başlıksız)";
  switch (event) {
    case "CARD_CREATED":
      return `📌 Yeni kart oluşturuldu: "${baslik}"`;
    case "CARD_MOVED":
      return `🔀 "${baslik}" kartı ${payload.fromColumn} → ${payload.toColumn} taşındı`;
    case "CARD_ASSIGNED": {
      const atananlar = Array.isArray(payload.assignees) ? payload.assignees.join(", ") : "";
      return `👤 "${baslik}" kartı ${atananlar} kişisine atandı`;
    }
    case "CARD_COMMENTED": {
      const onizleme = typeof payload.text === "string" ? payload.text.slice(0, 120) : "";
      return `💬 ${payload.authorName}, "${baslik}" kartına yorum yaptı: "${onizleme}"`;
    }
    case "CHANGE_REQUEST_APPROVED":
      return `✅ Değişiklik talebi onaylandı${baslik !== "(başlıksız)" ? `: "${baslik}"` : ""}`;
    default:
      return `Quantro olayı: ${event}`;
  }
}

// Slack/Discord gelen webhook URL'leri kendi sabit JSON semasini bekler
// (text / content) - kart bilgisiyle sarilmis genel govdeyi kabul etmezler.
// Kullanici hedefe gore ozel format yazmak zorunda kalmasin diye host adina
// bakip otomatik uyarliyoruz; taninmayan hedeflere genel, imzali govde gider.
function govdeUret(url: string, event: WebhookEvent, projectId: string, payload: Record<string, unknown>): string {
  const host = new URL(url).hostname;
  const mesaj = mesajUret(event, payload);
  if (host === "hooks.slack.com") return JSON.stringify({ text: mesaj });
  if (host === "discord.com" || host === "discordapp.com") return JSON.stringify({ content: mesaj });
  return JSON.stringify({ event, projectId, data: payload, timestamp: new Date().toISOString() });
}

export async function listWebhooks(projectId: string, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Webhook'ları sadece adminler görebilir");

  return prisma.outgoingWebhook.findMany({
    where: { projectId },
    select: { id: true, url: true, events: true, isActive: true, createdAt: true, createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

// Secret SADECE olusturulunca bir kez donuyor - sonrasinda tekrar
// gosterilmiyor (API key/token'larla ayni desen, bkz. api-token.service.ts).
export async function createWebhook(projectId: string, input: CreateWebhookInput, userId: string) {
  const { role } = await checkProjectAccess(projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Webhook'ları sadece adminler oluşturabilir");

  try {
    await guvenliWebhookUrlDogrula(input.url);
  } catch (err) {
    if (err instanceof WebhookGuvenlikHatasi) throw new ForbiddenError(err.message);
    throw err;
  }

  const secret = yeniSecret();
  const webhook = await prisma.outgoingWebhook.create({
    data: {
      projectId,
      url: input.url,
      secret,
      events: input.events as WebhookEvent[],
      createdById: userId,
    },
  });

  return { ...webhook, secret };
}

export async function updateWebhook(webhookId: string, input: UpdateWebhookInput, userId: string) {
  const webhook = await prisma.outgoingWebhook.findUnique({ where: { id: webhookId } });
  if (!webhook) throw new NotFoundError("Webhook");

  const { role } = await checkProjectAccess(webhook.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Webhook'ları sadece adminler değiştirebilir");

  if (input.url) {
    try {
      await guvenliWebhookUrlDogrula(input.url);
    } catch (err) {
      if (err instanceof WebhookGuvenlikHatasi) throw new ForbiddenError(err.message);
      throw err;
    }
  }

  return prisma.outgoingWebhook.update({
    where: { id: webhookId },
    data: {
      url: input.url,
      events: input.events as WebhookEvent[] | undefined,
      isActive: input.isActive,
    },
  });
}

export async function deleteWebhook(webhookId: string, userId: string) {
  const webhook = await prisma.outgoingWebhook.findUnique({ where: { id: webhookId } });
  if (!webhook) throw new NotFoundError("Webhook");

  const { role } = await checkProjectAccess(webhook.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Webhook'ları sadece adminler silebilir");

  await prisma.outgoingWebhook.delete({ where: { id: webhookId } });
}

async function birKezDene(url: string, govde: string, secret: string): Promise<void> {
  // redirect:'manual' KASITLI - bir yonlendirmeyi kontrolsuz takip etmek
  // guvenli-dogrulanmis URL'i atlayip baska bir hedefe cikabilirdi.
  const controller = new AbortController();
  const zamanAsimi = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Quantro-Signature": imzala(govde, secret),
      },
      body: govde,
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      // 3xx (redirect) de basarisiz sayilir - takip etmiyoruz.
      if (res.status >= 300) {
        throw new Error(`HTTP ${res.status}`);
      }
      const uzunluk = res.headers.get("content-length");
      if (uzunluk && Number(uzunluk) > MAX_YANIT_BOYUTU) {
        throw new Error("Yanıt boyutu sınırı aşıldı");
      }
    } finally {
      // Govdeyi kullanmiyoruz ama okumazsak baglanti acik kalabilir -
      // hemen iptal ederek soketi serbest birakiyoruz.
      await res.body?.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(zamanAsimi);
  }
}

// Fire-and-forget: cagiran (card.service.ts vb.) bunu beklemeden devam eder,
// bir webhook'un yavas/cevapsiz olmasi kullanicinin islemini geciktirmemeli.
export async function dispatchEvent(projectId: string, event: WebhookEvent, payload: Record<string, unknown>) {
  const webhooks = await prisma.outgoingWebhook.findMany({
    where: { projectId, isActive: true, events: { has: event } },
  });
  if (webhooks.length === 0) return;

  for (const webhook of webhooks) {
    const delivery = await prisma.webhookDelivery.create({
      data: { webhookId: webhook.id, event, payload: payload as Prisma.InputJsonValue, status: "PENDING" },
    });

    void (async () => {
      for (let deneme = 0; deneme < MAX_DENEME; deneme++) {
        try {
          // DNS rebinding: kayit anindan bu ana kadar hostname'in cozdugu
          // IP degismis olabilir - HER gonderimden once TEKRAR dogrula.
          await guvenliWebhookUrlDogrula(webhook.url);
          const govde = govdeUret(webhook.url, event, projectId, payload);
          await birKezDene(webhook.url, govde, webhook.secret);
          await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: "SUCCESS", attempts: deneme + 1, deliveredAt: new Date() },
          });
          return;
        } catch (err) {
          const mesaj = err instanceof Error ? err.message : String(err);
          if (deneme === MAX_DENEME - 1) {
            await prisma.webhookDelivery.update({
              where: { id: delivery.id },
              data: { status: "FAILED", attempts: deneme + 1, lastError: mesaj },
            });
            return;
          }
          await new Promise((r) => setTimeout(r, GERI_CEKILME_MS[deneme] ?? 30000));
        }
      }
    })().catch((err) => console.error("[webhook] Dispatch beklenmeyen hata:", err));
  }
}
