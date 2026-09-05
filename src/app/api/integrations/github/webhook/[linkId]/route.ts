import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { githubImzasiDogrula } from "@/utils/github-signature";
import { handleEvent } from "@/services/github-webhook.service";
import { checkGithubWebhookRateLimit } from "@/middleware/rateLimit";

// GitHub webhook alicisi. KIMLIK DOGRULAMASI JWT DEGIL, HMAC IMZASIDIR:
// GitHub'in bize gonderebilecegi bir oturum yok, guvenilen tek sey depo
// ayarlarindaki secret ile hesaplanmis X-Hub-Signature-256.
//
// Adres link basina (/[linkId]): her projenin kendi secret'i var ve tek bir
// adres olsaydi hangi secret ile dogrulayacagimizi bulmak icin IMZAYI
// DOGRULAMADAN ONCE govdeyi ayristirmak gerekirdi. linkId'nin gizli olmasi
// gerekmiyor - dogrulamayi imza yapiyor.

// Govde tavani. GitHub'in kendi siniri 25MB; bizim isledigimiz olaylarda
// yuk birkac yuz KB'i gecmiyor, gerisini bellege almanin anlami yok.
const MAKS_GOVDE = 1_000_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ linkId: string }> }) {
  const { linkId } = await params;

  // Kova anahtari linkId: GitHub'in IP havuzu genis ve degisken oldugu icin
  // IP bazli sayim ya cok gevsek kalir ya da mesru trafigi keser.
  const rateLimited = checkGithubWebhookRateLimit(linkId);
  if (rateLimited) return rateLimited;

  try {
    const uzunluk = Number(request.headers.get("content-length") ?? 0);
    if (uzunluk > MAKS_GOVDE) {
      return NextResponse.json({ error: "Gövde çok büyük" }, { status: 413 });
    }

    // HAM govde: JSON.parse edip yeniden serilestirmek anahtar sirasini ve
    // kacislari degistirir, imza tutmaz.
    const hamGovde = await request.text();
    if (hamGovde.length > MAKS_GOVDE) {
      return NextResponse.json({ error: "Gövde çok büyük" }, { status: 413 });
    }

    const link = await prisma.githubRepoLink.findUnique({ where: { id: linkId } });
    // Pasif baglanti da yok sayiliyor; kullanici webhook'u GitHub'dan
    // silmeden ozelligi durdurabilmeli.
    if (!link || !link.isActive) {
      return NextResponse.json({ error: "Bulunamadı" }, { status: 404 });
    }

    const imzaGecerli = githubImzasiDogrula(
      hamGovde,
      request.headers.get("x-hub-signature-256"),
      link.secret,
    );
    if (!imzaGecerli) {
      // Sebep AYRINTILANDIRILMIYOR ("imza yok" / "imza yanlis" ayrimi bile):
      // dogrulama bu ucun tek kapisi, saldirgana geri bildirim vermiyoruz.
      return NextResponse.json({ error: "Geçersiz imza" }, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(hamGovde);
    } catch {
      return NextResponse.json({ error: "Geçersiz gövde" }, { status: 400 });
    }

    // Imza dogru olsa bile yukun BASKA bir depoya ait olmadigini kontrol
    // ediyoruz: ayni secret'i iki depoya kuran bir kullanici, ikinci deponun
    // olaylariyla bu projenin kartlarini oynatabilirdi.
    const depo = (payload as { repository?: { full_name?: string } })?.repository?.full_name;
    if (depo && depo.toLowerCase() !== `${link.owner}/${link.repo}`.toLowerCase()) {
      return NextResponse.json({ error: "Depo eşleşmiyor" }, { status: 404 });
    }

    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery");
    // Teslimat kimligi tekillestirmenin dayanagi; yoksa istek GitHub'dan
    // gelmiyor demektir.
    if (!deliveryId) return NextResponse.json({ error: "Eksik başlık" }, { status: 400 });

    const sonuc = await handleEvent({ link, event, deliveryId, payload });

    // Islenmemis olaylar da 200 doner: GitHub ardarda basarisiz teslimattan
    // sonra webhook'u kendiliginden devre disi birakiyor ve "bu olayla
    // ilgilenmiyoruz" bir hata degil.
    return NextResponse.json({ ok: true, ...sonuc }, { status: 200 });
  } catch (error) {
    // GOVDE LOGLANMIYOR: commit mesaji ve dal adlari sir, ic adres ya da
    // musteri adi tasiyabilir (ai.service.ts'te ayni not var).
    console.error(`[github-webhook] link=${linkId} isleme hatasi:`, error instanceof Error ? error.message : error);
    // 500 dondurmek GitHub'in webhook'u devre disi birakmasina yol acar;
    // hata bizim tarafimizda, teslimat gecerliydi.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
