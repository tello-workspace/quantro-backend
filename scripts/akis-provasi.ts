/**
 * Uctan uca AKIS PROVASI.
 *
 * Mevcut testler (src/services/__tests__) servis fonksiyonlarini DOGRUDAN
 * cagiriyor - yani auth middleware'i, zod dogrulamasi, HTTP durum kodlari ve
 * route <-> servis kablolamasi hic calistirilmiyor. 110 route var, hicbiri
 * HTTP seviyesinde test edilmiyordu.
 *
 * Bu betik AYAKTA OLAN sunucuya (varsayilan http://localhost:4000) gercek
 * istekler atarak her ana akisi bastan sona yurutur ve iki seyi arar:
 *   1. Beklenen durum kodu gelmiyor mu (akis kirik mi).
 *   2. Yetkisiz kullanici (org disindan biri) 200 alabiliyor mu (RBAC kacagi).
 *
 * Kullanim:
 *   npx tsx scripts/akis-provasi.ts                 # varsayilan taban adres
 *   API=http://localhost:4000/api npx tsx scripts/akis-provasi.ts
 *
 * Veri: fixtures ile benzersiz (TEST_TAG'li) org/proje/kullanici olusturur ve
 * sonunda hepsini siler. Mevcut takim verisine dokunmaz.
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/utils/jwt";
import { createWorkspace, createUser, cleanup, uniq } from "@/test/fixtures";

const API = process.env.API ?? "http://localhost:4000/api";

type Yontem = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Sonuc {
  akis: string;
  ad: string;
  yontem: Yontem;
  yol: string;
  beklenen: number[];
  gelen: number;
  gecti: boolean;
  govde?: unknown;
}

const sonuclar: Sonuc[] = [];
let suankiAkis = "-";

function akis(ad: string) {
  suankiAkis = ad;
}

interface CagriSecenek {
  token?: string;
  govde?: unknown;
  beklenen?: number[];
  /** Yanit govdesini dondurup sonraki adimda kullanmak icin. */
  sessiz?: boolean;
}

async function cagir(
  ad: string,
  yontem: Yontem,
  yol: string,
  { token, govde, beklenen = [200, 201] }: CagriSecenek = {},
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (govde !== undefined) headers["Content-Type"] = "application/json";

  let status = 0;
  let data: any = null;
  try {
    const res = await fetch(`${API}${yol}`, {
      method: yontem,
      headers,
      body: govde === undefined ? undefined : JSON.stringify(govde),
    });
    status = res.status;
    const metin = await res.text();
    try {
      data = metin ? JSON.parse(metin) : null;
    } catch {
      data = metin.slice(0, 300);
    }
  } catch (err) {
    status = -1;
    data = String(err);
  }

  const gecti = beklenen.includes(status);
  sonuclar.push({
    akis: suankiAkis,
    ad,
    yontem,
    yol,
    beklenen,
    gelen: status,
    gecti,
    govde: gecti ? undefined : data,
  });
  return { status, data };
}

/** Yetkisiz erisim provasi: 200 gelmemeli. */
async function yasak(ad: string, yontem: Yontem, yol: string, token: string, govde?: unknown) {
  return cagir(ad, yontem, yol, { token, govde, beklenen: [401, 403, 404] });
}

async function main() {
  console.log(`Akis provasi baslıyor -> ${API}\n`);

  // ---------------------------------------------------------------- kurulum
  const ws = await createWorkspace();
  const yabanci = ws.outsider;
  const adminToken = signToken({ userId: ws.admin.id, email: ws.admin.email });
  const uyeToken = signToken({ userId: ws.member.id, email: ws.member.email });
  const yabanciToken = signToken({ userId: yabanci.id, email: yabanci.email });
  const davetliKullanici = await createUser("Davetli");

  const temizlik = { orgIds: [ws.org.id], userIds: [ws.admin.id, ws.member.id, yabanci.id, davetliKullanici.id] };

  try {
    // ------------------------------------------------------------ 1. kimlik
    akis("1-kimlik");
    await cagir("token yok -> 401", "GET", "/auth/me", { beklenen: [401] });
    await cagir("bozuk token -> 401", "GET", "/auth/me", { token: "abc.def.ghi", beklenen: [401] });
    await cagir("gecerli token", "GET", "/auth/me", { token: adminToken });
    await cagir("profil guncelle", "PATCH", "/auth/me", { token: adminToken, govde: { name: "Admin User" } });
    await cagir(
      "aiBaseUrl SSRF reddedilmeli",
      "PATCH",
      "/auth/me",
      { token: adminToken, govde: { aiBaseUrl: "http://169.254.169.254/latest/meta-data" }, beklenen: [400, 422] },
    );
    await cagir("kayit: gecersiz e-posta", "POST", "/auth/register", {
      govde: { name: "x", email: "gecersiz", password: "test1234" },
      beklenen: [400, 422],
    });
    await cagir("kayit: kisa sifre", "POST", "/auth/register", {
      govde: { name: "x", email: `${uniq("yeni")}@example.com`, password: "123" },
      beklenen: [400, 422],
    });
    await cagir("giris: yanlis sifre", "POST", "/auth/login", {
      govde: { email: ws.admin.email, password: "yanlis-sifre" },
      beklenen: [400, 401],
    });
    await cagir("giris: dogru sifre", "POST", "/auth/login", {
      govde: { email: ws.admin.email, password: "test1234" },
    });
    await cagir("sifre unuttum (var olmayan e-posta da 200 donmeli - enumeration)", "POST", "/auth/forgot-password", {
      govde: { email: `${uniq("yok")}@example.com` },
      beklenen: [200, 202],
    });

    // ------------------------------------------------------ 2. organizasyon
    akis("2-organizasyon");
    await cagir("org listesi", "GET", "/organizations", { token: adminToken });
    await cagir("org detay", "GET", `/organizations/${ws.org.id}`, { token: adminToken });
    await cagir("org uyeleri", "GET", `/organizations/${ws.org.id}/members`, { token: adminToken, beklenen: [200, 405] });
    await cagir("org davet olustur", "POST", `/organizations/${ws.org.id}/members`, {
      token: adminToken,
      govde: { email: davetliKullanici.email, role: "MEMBER" },
      beklenen: [200, 201],
    });
    await cagir("davetlerim", "GET", "/invitations", { token: davetliKullanici.id ? signToken({ userId: davetliKullanici.id, email: davetliKullanici.email }) : "" });
    await cagir("org rozetleri", "GET", `/organizations/${ws.org.id}/badges`, { token: adminToken });
    await cagir("org arama", "GET", `/organizations/${ws.org.id}/search?q=test`, { token: adminToken });
    await cagir("org mesajlari", "GET", `/organizations/${ws.org.id}/messages`, { token: adminToken });
    await cagir("org mail kutusu", "GET", `/organizations/${ws.org.id}/mail`, { token: adminToken });
    await cagir("org mail okunmamis", "GET", `/organizations/${ws.org.id}/mail/unread-count`, { token: adminToken });
    await cagir("proje sablonlari", "GET", `/organizations/${ws.org.id}/project-templates`, { token: adminToken });
    await cagir("degisiklik talepleri", "GET", `/organizations/${ws.org.id}/requests`, { token: adminToken });

    // ------------------------------------------------------------- 3. proje
    akis("3-proje");
    await cagir("org projeleri", "GET", `/organizations/${ws.org.id}/projects`, { token: adminToken });
    const yeniProje = await cagir("proje olustur", "POST", `/organizations/${ws.org.id}/projects`, {
      token: adminToken,
      govde: { name: uniq("prova-proje"), key: "PRV", description: "akis provasi" },
    });
    const projeId: string | undefined = yeniProje.data?.data?.id ?? yeniProje.data?.data?.project?.id;
    await cagir("proje detay", "GET", `/organizations/${ws.org.id}/projects/${ws.project.id}`, { token: adminToken });
    await cagir("pano", "GET", `/projects/${ws.project.id}/board`, { token: adminToken });
    await cagir("proje ozeti", "GET", `/projects/${ws.project.id}/summary`, { token: adminToken });
    await cagir("aktiviteler", "GET", `/projects/${ws.project.id}/activities`, { token: adminToken });
    await cagir("icgoruler", "GET", `/projects/${ws.project.id}/insights`, { token: adminToken });
    await cagir("kumulatif akis", "GET", `/projects/${ws.project.id}/cumulative-flow`, { token: adminToken });
    await cagir("cycle time", "GET", `/projects/${ws.project.id}/cycle-time`, { token: adminToken });
    await cagir("yol haritasi", "GET", `/projects/${ws.project.id}/roadmap`, { token: adminToken });
    await cagir("arsivlenmis kartlar", "GET", `/projects/${ws.project.id}/cards/archived`, { token: adminToken });
    await cagir("belgeler", "GET", `/projects/${ws.project.id}/documents`, { token: adminToken });
    await cagir("kayitli gorunumler", "GET", `/projects/${ws.project.id}/saved-views`, { token: adminToken });
    await cagir("webhook listesi", "GET", `/projects/${ws.project.id}/webhooks`, { token: adminToken });
    await cagir("proje uyeleri", "GET", `/organizations/${ws.org.id}/projects/${ws.project.id}/members`, { token: adminToken });
    await cagir("etiketler", "GET", `/organizations/${ws.org.id}/projects/${ws.project.id}/labels`, { token: adminToken });
    await cagir("ozel alanlar", "GET", `/organizations/${ws.org.id}/projects/${ws.project.id}/custom-fields`, { token: adminToken });
    await cagir("otomasyonlar", "GET", `/organizations/${ws.org.id}/projects/${ws.project.id}/automations`, { token: adminToken });
    await cagir("kart sablonlari", "GET", `/organizations/${ws.org.id}/projects/${ws.project.id}/templates`, { token: adminToken });
    await cagir("kolonlar", "GET", `/organizations/${ws.org.id}/projects/${ws.project.id}/columns`, { token: adminToken });

    // ------------------------------------------------------------ 4. kolon
    akis("4-kolon");
    const yeniKolon = await cagir("kolon olustur", "POST", `/organizations/${ws.org.id}/projects/${ws.project.id}/columns`, {
      token: adminToken,
      govde: { name: "Prova Kolonu" },
    });
    const kolonId: string | undefined = yeniKolon.data?.data?.id;
    if (kolonId) {
      await cagir("kolon detay", "GET", `/columns/${kolonId}`, { token: adminToken });
      await cagir("kolon guncelle (wip)", "PATCH", `/columns/${kolonId}`, {
        token: adminToken,
        govde: { name: "Prova Kolonu 2", wipLimit: 2 },
      });
      await cagir("kolon kartlari", "GET", `/columns/${kolonId}/cards`, { token: adminToken });
    }

    // ------------------------------------------------------------- 5. kart
    akis("5-kart");
    const kart1 = await cagir("kart olustur", "POST", `/columns/${ws.todo.id}/cards`, {
      token: adminToken,
      govde: { title: "Prova kartı", description: "akış provası", priority: "HIGH" },
    });
    const kartId: string | undefined = kart1.data?.data?.id;
    const kart2 = await cagir("ikinci kart", "POST", `/columns/${ws.todo.id}/cards`, {
      token: adminToken,
      govde: { title: "Engelleyen kart" },
    });
    const kart2Id: string | undefined = kart2.data?.data?.id;

    await cagir("baslik bos -> dogrulama hatasi", "POST", `/columns/${ws.todo.id}/cards`, {
      token: adminToken,
      govde: { title: "" },
      beklenen: [400, 422],
    });

    if (kartId) {
      await cagir("kart detay", "GET", `/cards/${kartId}`, { token: adminToken });
      await cagir("kart guncelle", "PATCH", `/cards/${kartId}`, {
        token: adminToken,
        govde: { title: "Prova kartı (güncel)", priority: "URGENT" },
      });
      await cagir("kart tasi", "POST", `/cards/${kartId}/move`, {
        token: adminToken,
        govde: { columnId: ws.done.id, position: 0 },
      });
      await cagir("yorum ekle", "POST", `/cards/${kartId}/comments`, {
        token: adminToken,
        govde: { content: "prova yorumu" },
      });
      await cagir("yorumlari listele", "GET", `/cards/${kartId}/comments`, { token: adminToken });
      await cagir("checklist ekle", "POST", `/cards/${kartId}/checklist`, {
        token: adminToken,
        govde: { title: "prova maddesi" },
      });
      await cagir("checklist listele", "GET", `/cards/${kartId}/checklist`, { token: adminToken });
      await cagir("izlemeye al", "POST", `/cards/${kartId}/watch`, { token: adminToken });
      await cagir("izleme durumu", "GET", `/cards/${kartId}/watch`, { token: adminToken });
      await cagir("sure kaydi ekle", "POST", `/cards/${kartId}/time-logs`, {
        token: adminToken,
        govde: { minutes: 30, note: "prova" },
      });
      await cagir("sure kayitlari", "GET", `/cards/${kartId}/time-logs`, { token: adminToken });
      await cagir("ek listesi", "GET", `/cards/${kartId}/attachments`, { token: adminToken });
      await cagir("tekrarlama ayari", "GET", `/cards/${kartId}/recurrence`, { token: adminToken });

      if (kart2Id) {
        await cagir("bagimlilik ekle", "POST", `/cards/${kartId}/dependencies`, {
          token: adminToken,
          govde: { blockerId: kart2Id },
        });
        await cagir("kendine bagimlilik reddedilmeli", "POST", `/cards/${kartId}/dependencies`, {
          token: adminToken,
          govde: { blockerId: kartId },
          beklenen: [400, 409, 422],
        });
        await cagir("dongusel bagimlilik reddedilmeli", "POST", `/cards/${kart2Id}/dependencies`, {
          token: adminToken,
          govde: { blockerId: kartId },
          beklenen: [400, 409, 422],
        });
      }

      await cagir("kart kopyala", "POST", `/cards/${kartId}/duplicate`, { token: adminToken });
      await cagir("kart arsivle", "POST", `/cards/${kartId}/archive`, { token: adminToken });
      await cagir("kart geri al", "POST", `/cards/${kartId}/restore`, { token: adminToken });
      await cagir("sablon olarak kaydet", "POST", `/cards/${kartId}/save-as-template`, {
        token: adminToken,
        govde: { name: uniq("sablon") },
      });
    }

    await cagir("toplu islem", "POST", `/projects/${ws.project.id}/cards/bulk`, {
      token: adminToken,
      govde: kartId ? { cardIds: [kartId], action: "move", columnId: ws.todo.id } : { cardIds: [], action: "move", columnId: ws.todo.id },
      beklenen: [200, 400, 422],
    });

    // -------------------------------------------------------------- 6. ben
    akis("6-kullanici");
    await cagir("atanan kartlarim", "GET", "/me/assigned-cards", { token: adminToken });
    await cagir("izledigim kartlar", "GET", "/me/watched-cards", { token: adminToken });
    await cagir("bildirim tercihleri", "GET", "/me/notification-preferences", { token: adminToken });
    await cagir("api anahtarlari", "GET", "/me/api-tokens", { token: adminToken });
    const anahtar = await cagir("api anahtari olustur", "POST", "/me/api-tokens", {
      token: adminToken,
      govde: { name: uniq("prova-anahtar") },
    });
    const anahtarDegeri: string | undefined = anahtar.data?.data?.token ?? anahtar.data?.data?.value;
    if (anahtarDegeri) {
      await cagir("api anahtari ile kimlik", "GET", "/auth/me", { token: anahtarDegeri });
    }
    await cagir("bildirimler", "GET", "/notifications", { token: adminToken });
    await cagir("okunmamis sayisi", "GET", "/notifications/unread-count", { token: adminToken });
    await cagir("hepsini okundu isaretle", "PATCH", "/notifications/read-all", { token: adminToken });

    // ------------------------------------------------------------ 7. disari
    akis("7-disa-aktarma");
    await cagir("xlsx", "GET", `/projects/${ws.project.id}/export?format=xlsx`, { token: adminToken });
    await cagir("csv", "GET", `/projects/${ws.project.id}/export?format=csv`, { token: adminToken });
    await cagir("json", "GET", `/projects/${ws.project.id}/export?format=json`, { token: adminToken });
    await cagir("gecersiz format", "GET", `/projects/${ws.project.id}/export?format=exe`, {
      token: adminToken,
      beklenen: [400, 422],
    });

    // ------------------------------------------------------- 8. RBAC kacagi
    // Org disindan biri (yabanci) hicbir seyi GOREMEMELI.
    akis("8-rbac-yabanci");
    await yasak("org detay", "GET", `/organizations/${ws.org.id}`, yabanciToken);
    await yasak("org projeleri", "GET", `/organizations/${ws.org.id}/projects`, yabanciToken);
    await yasak("org arama", "GET", `/organizations/${ws.org.id}/search?q=a`, yabanciToken);
    await yasak("org mesajlari", "GET", `/organizations/${ws.org.id}/messages`, yabanciToken);
    await yasak("org mail", "GET", `/organizations/${ws.org.id}/mail`, yabanciToken);
    await yasak("org uye ekle", "POST", `/organizations/${ws.org.id}/members`, yabanciToken, {
      email: "x@example.com",
      role: "ADMIN",
    });
    await yasak("pano", "GET", `/projects/${ws.project.id}/board`, yabanciToken);
    await yasak("proje ozeti", "GET", `/projects/${ws.project.id}/summary`, yabanciToken);
    await yasak("aktiviteler", "GET", `/projects/${ws.project.id}/activities`, yabanciToken);
    await yasak("icgoruler", "GET", `/projects/${ws.project.id}/insights`, yabanciToken);
    await yasak("kumulatif akis", "GET", `/projects/${ws.project.id}/cumulative-flow`, yabanciToken);
    await yasak("cycle time", "GET", `/projects/${ws.project.id}/cycle-time`, yabanciToken);
    await yasak("yol haritasi", "GET", `/projects/${ws.project.id}/roadmap`, yabanciToken);
    await yasak("arsiv", "GET", `/projects/${ws.project.id}/cards/archived`, yabanciToken);
    await yasak("belgeler", "GET", `/projects/${ws.project.id}/documents`, yabanciToken);
    await yasak("kayitli gorunumler", "GET", `/projects/${ws.project.id}/saved-views`, yabanciToken);
    await yasak("webhooklar", "GET", `/projects/${ws.project.id}/webhooks`, yabanciToken);
    await yasak("disa aktar", "GET", `/projects/${ws.project.id}/export?format=json`, yabanciToken);
    await yasak("kolon kartlari", "GET", `/columns/${ws.todo.id}/cards`, yabanciToken);
    await yasak("kolona kart ekle", "POST", `/columns/${ws.todo.id}/cards`, yabanciToken, { title: "sizinti" });
    await yasak("kolon detay", "GET", `/columns/${ws.todo.id}`, yabanciToken);
    await yasak("kolon sil", "DELETE", `/columns/${ws.todo.id}`, yabanciToken);
    if (kartId) {
      await yasak("kart detay", "GET", `/cards/${kartId}`, yabanciToken);
      await yasak("kart guncelle", "PATCH", `/cards/${kartId}`, yabanciToken, { title: "ele gecirildi" });
      await yasak("kart sil", "DELETE", `/cards/${kartId}`, yabanciToken);
      await yasak("kart tasi", "POST", `/cards/${kartId}/move`, yabanciToken, { columnId: ws.done.id, position: 0 });
      await yasak("yorum ekle", "POST", `/cards/${kartId}/comments`, yabanciToken, { content: "sizinti" });
      await yasak("yorumlari oku", "GET", `/cards/${kartId}/comments`, yabanciToken);
      await yasak("checklist oku", "GET", `/cards/${kartId}/checklist`, yabanciToken);
      await yasak("ekleri oku", "GET", `/cards/${kartId}/attachments`, yabanciToken);
      await yasak("sure kayitlari", "GET", `/cards/${kartId}/time-logs`, yabanciToken);
      await yasak("izlemeye al", "POST", `/cards/${kartId}/watch`, yabanciToken);
      await yasak("kart kopyala", "POST", `/cards/${kartId}/duplicate`, yabanciToken);
      await yasak("kart arsivle", "POST", `/cards/${kartId}/archive`, yabanciToken);
      await yasak("AI sohbet", "POST", "/ai/chat", yabanciToken, {
        projectId: ws.project.id,
        messages: [{ role: "user", content: "kartlari listele" }],
      });
      await yasak("AI doldur", "POST", "/ai/fill", yabanciToken, { projectId: ws.project.id, title: "x" });
      await yasak("AI icgoru", "GET", `/ai/insights?projectId=${ws.project.id}`, yabanciToken);
    }

    // ------------------------------------------- 9. MEMBER yetki sinirlari
    akis("9-rbac-uye");
    await cagir("uye panoyu gorebilir", "GET", `/projects/${ws.project.id}/board`, { token: uyeToken });
    await cagir("uye kart olusturabilir", "POST", `/columns/${ws.todo.id}/cards`, {
      token: uyeToken,
      govde: { title: "uye kartı" },
    });
    await yasak("uye org silemez", "DELETE", `/organizations/${ws.org.id}`, uyeToken);
    await yasak("uye org uyesi ekleyemez", "POST", `/organizations/${ws.org.id}/members`, uyeToken, {
      email: "x@example.com",
      role: "ADMIN",
    });
    await yasak("uye proje gorunurlugunu degistiremez", "PATCH", `/organizations/${ws.org.id}/projects/${ws.project.id}/visibility`, uyeToken, {
      visibility: "PRIVATE",
    });

    // --------------------------------------------- 10. cron / admin uclari
    akis("10-korunan-uclar");
    await cagir("digest sirri olmadan", "POST", "/digest", { beklenen: [401, 403] });
    await cagir("scan sirri olmadan", "POST", "/scan", { beklenen: [401, 403] });
    await cagir("hata kayitlari (yabanci)", "GET", "/error-logs", { token: yabanciToken, beklenen: [200, 401, 403] });

    // -------------------------------------------- 11. var olmayan kaynaklar
    akis("11-yok-kaynak");
    const sahteId = "00000000-0000-0000-0000-000000000000";
    await cagir("olmayan kart", "GET", `/cards/${sahteId}`, { token: adminToken, beklenen: [400, 404] });
    await cagir("olmayan proje panosu", "GET", `/projects/${sahteId}/board`, { token: adminToken, beklenen: [400, 403, 404] });
    await cagir("olmayan org", "GET", `/organizations/${sahteId}`, { token: adminToken, beklenen: [400, 403, 404] });
    await cagir("bicimsiz id", "GET", "/cards/bu-bir-id-degil", { token: adminToken, beklenen: [400, 404] });
  } finally {
    await cleanup(temizlik);
    await prisma.$disconnect();
  }

  // ------------------------------------------------------------------ rapor
  const basarisiz = sonuclar.filter((s) => !s.gecti);
  const akisAdlari = [...new Set(sonuclar.map((s) => s.akis))];

  console.log("\n================ AKIS PROVASI RAPORU ================\n");
  for (const a of akisAdlari) {
    const grup = sonuclar.filter((s) => s.akis === a);
    const kotu = grup.filter((s) => !s.gecti).length;
    console.log(`${kotu === 0 ? "OK  " : "FAIL"} ${a.padEnd(20)} ${grup.length - kotu}/${grup.length}`);
  }

  if (basarisiz.length) {
    console.log("\n---------------- BASARISIZ ADIMLAR ----------------\n");
    for (const s of basarisiz) {
      console.log(`[${s.akis}] ${s.ad}`);
      console.log(`   ${s.yontem} ${s.yol}`);
      console.log(`   beklenen ${s.beklenen.join("/")} -> GELEN ${s.gelen}`);
      const g = typeof s.govde === "string" ? s.govde : JSON.stringify(s.govde);
      if (g) console.log(`   govde: ${g.slice(0, 300)}`);
      console.log("");
    }
  }

  console.log(`\nTOPLAM: ${sonuclar.length} adim, ${basarisiz.length} basarisiz\n`);
  process.exit(basarisiz.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Prova cokti:", err);
  await prisma.$disconnect();
  process.exit(1);
});
