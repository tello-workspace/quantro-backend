import crypto from "node:crypto";
import https from "node:https";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError } from "@/utils/errors";
import { guvenliWebhookUrlDogrula, guvenliWebhookHedefiCoz, WebhookGuvenlikHatasi } from "@/utils/webhook-security";
import type { GuvenliWebhookHedefi } from "@/utils/webhook-security";
import { checkProjectAccess } from "@/services/access-control.service";
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

  // secret'i ACIKCA select disinda birakiyoruz: select verilmezse Prisma tum
  // alanlari doner ve PATCH yaniti (bos govdeyle bile) imzalama sirrini
  // istemciye sizdirirdi - "sadece olusturulunca bir kez gosterilir"
  // sozlesmesi bunu yasakliyor (bkz. createWebhook, listWebhooks).
  return prisma.outgoingWebhook.update({
    where: { id: webhookId },
    data: {
      url: input.url,
      events: input.events as WebhookEvent[] | undefined,
      isActive: input.isActive,
    },
    select: { id: true, projectId: true, url: true, events: true, isActive: true, createdById: true, createdAt: true },
  });
}

export async function deleteWebhook(webhookId: string, userId: string) {
  const webhook = await prisma.outgoingWebhook.findUnique({ where: { id: webhookId } });
  if (!webhook) throw new NotFoundError("Webhook");

  const { role } = await checkProjectAccess(webhook.projectId, userId);
  if (role !== "ADMIN") throw new ForbiddenError("Webhook'ları sadece adminler silebilir");

  await prisma.outgoingWebhook.delete({ where: { id: webhookId } });
}

// fetch yerine node:https KASITLI: fetch hostname'i KENDISI tekrar cozer,
// yani guvenlik dogrulamasinin bakip onayladigi IP ile gercekten baglanilan
// IP farkli olabilirdi (TOCTOU / DNS rebinding). https.request'in `lookup`
// kancasi ile dogrulanan IP'ye pinliyoruz; Host basligi ve TLS SNI orijinal
// hostname olarak kaliyor, yani karsi taraf icin hicbir sey degismiyor.
async function birKezDene(hedef: GuvenliWebhookHedefi, govde: string, secret: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let zamanAsimi: NodeJS.Timeout | undefined;
    let bitti = false;
    const bitir = (hata?: Error) => {
      if (bitti) return;
      bitti = true;
      if (zamanAsimi) clearTimeout(zamanAsimi);
      if (hata) reject(hata);
      else resolve();
    };

    // Yonlendirme TAKIP EDILMIYOR - https.request zaten kendiliginden
    // takip etmez (eski koddaki redirect:'manual' ile ayni davranis).
    const istek = https.request(
      {
        hostname: hedef.url.hostname,
        port: hedef.url.port || 443,
        path: `${hedef.url.pathname}${hedef.url.search}`,
        method: "POST",
        servername: hedef.url.hostname,
        lookup: (_hostname, _secenekler, cb) => cb(null, hedef.ip, hedef.ailesi),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(govde),
          "X-Quantro-Signature": imzala(govde, secret),
        },
      },
      (res) => {
        // Govdeyi kullanmiyoruz ama okumazsak baglanti acik kalabilir -
        // hemen iptal ederek soketi serbest birakiyoruz.
        res.destroy();
        const durum = res.statusCode ?? 0;
        // 3xx (redirect) de basarisiz sayilir - takip etmiyoruz.
        if (durum >= 300) return bitir(new Error(`HTTP ${durum}`));
        const uzunluk = res.headers["content-length"];
        if (uzunluk && Number(uzunluk) > MAX_YANIT_BOYUTU) {
          return bitir(new Error("Yanıt boyutu sınırı aşıldı"));
        }
        bitir();
      }
    );

    zamanAsimi = setTimeout(() => istek.destroy(new Error("Webhook isteği zaman aşımına uğradı")), 8000);
    istek.on("error", (err) => bitir(err));
    istek.end(govde);
  });
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
          // Dogrulanan IP'yi birKezDene'ye TASIYORUZ: eskiden yalnizca
          // dogrulama yapilip IP atiliyor, baglanti ikinci bir DNS
          // cozumlemesiyle kuruluyordu - arada cevap degisirse (rebinding)
          // kontrol bosa cikiyordu.
          const hedef = await guvenliWebhookHedefiCoz(webhook.url);
          const govde = govdeUret(webhook.url, event, projectId, payload);
          await birKezDene(hedef, govde, webhook.secret);
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
          // Ara denemeler DB'ye hic yazilmadigi icin, surec bekleme
          // sirasinda olur/uyursa (deploy, restart, Render uykusu) kayit
          // attempts=0 + lastError=null halinde sonsuza dek PENDING kalip
          // "olu mektup" gorunurlugunu yok ediyordu. Her basarisiz
          // denemeden HEMEN sonra sayaci ve son hatayi yaziyoruz; bu
          // yazma patlarsa da tekrar dongusunu bozmasin diye yutuluyor.
          await prisma.webhookDelivery
            .update({ where: { id: delivery.id }, data: { attempts: deneme + 1, lastError: mesaj } })
            .catch(() => {});
          await new Promise((r) => setTimeout(r, GERI_CEKILME_MS[deneme] ?? 30000));
        }
      }
    })().catch((err) => console.error("[webhook] Dispatch beklenmeyen hata:", err));
  }
}
