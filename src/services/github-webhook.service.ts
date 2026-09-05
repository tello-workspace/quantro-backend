import { prisma } from "@/lib/prisma";
import { parseCardKey, formatCardKey } from "@/services/card-key.service";
import { sistemKartTasi } from "@/services/card-move.service";
import type { GithubLinkKind, GithubRepoLink } from "@prisma/client";

// GitHub olaylarini karta baglar ve karti tasir.
//
// Eslesme DETERMINISTIK: metinde gecen kart anahtari ("QNT-42") uzerinden.
// AI tahmini degil - branch adina anahtari yazan gelistirici ne olacagini
// tam olarak biliyor, sonuc her seferinde ayni ve hicbir maliyeti yok.

// Anahtar deseni card-key.service.ts'teki CARD_KEY_REGEX ile ayni bicim, ama
// metin ICINDE arama yaptigimiz icin sinir (\b) ile kapsanmis hali.
//
// Sagdaki \b tek basina yetmiyordu: "QNT-42x" gibi bir dizide \b, "2" ile
// "x" arasinda EŞLEŞMEZ ama regex geriye donup "QNT-4" ile duran bir eslesme
// uretebiliyor. (?!\w) ile rakamdan sonra harf/rakam/alt cizgi gelmemesini
// acikca sart kosuyoruz.
const METINDE_ANAHTAR = /\b([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,9})(?!\w)/g;

// Tek olayda islenecek anahtar sayisi tavani. Commit mesaji ya da PR govdesi
// tamamen yazarin kontrolunde; yuzlerce anahtar iceren bir govde tek istekte
// yuzlerce tasima + bildirim + socket yayini uretebilirdi.
const MAKS_ANAHTAR = 20;

// Tek push'ta bakilacak commit sayisi tavani. GitHub zaten 20 commit'ten
// sonrasini kirpiyor ama "force push"la gelen buyuk bir yigin da mumkun.
const MAKS_COMMIT = 50;

/**
 * Verilen metinlerde gecen kart anahtarlarini bulur, dogrular ve
 * tekillestirir. Buyuk harfe normalize edilmis halde doner ("qnt-42" ->
 * "QNT-42"): gelistirici branch adini kucuk harfle yazabilmeli.
 */
export function extractCardKeys(...metinler: (string | null | undefined)[]): string[] {
  const bulunanlar = new Set<string>();

  for (const metin of metinler) {
    if (!metin) continue;
    // exec dongusu yerine matchAll: lastIndex durumu tasimadigi icin ayni
    // regex nesnesini birden fazla metinde guvenle kullanabiliyoruz.
    for (const eslesme of metin.matchAll(METINDE_ANAHTAR)) {
      // parseCardKey bicimi ikinci kez dogruluyor (numara tasmasi, sifir vb.)
      // ve normalize edilmis hali donuyor - anahtar formatinin tek sahibi o.
      const ayrilmis = parseCardKey(eslesme[0]);
      if (!ayrilmis) continue;
      bulunanlar.add(formatCardKey(ayrilmis.projectKey, ayrilmis.number));
      if (bulunanlar.size >= MAKS_ANAHTAR) return [...bulunanlar];
    }
  }

  return [...bulunanlar];
}

/** refs/heads/feat/QNT-42-mail -> feat/QNT-42-mail. Dal degilse null. */
export function branchAdiCikar(ref: string | undefined): string | null {
  if (!ref || !ref.startsWith("refs/heads/")) return null;
  const ad = ref.slice("refs/heads/".length);
  return ad || null;
}

/**
 * Anahtarlari gercek kartlara cozer.
 *
 * KIRACI SINIRI: findCardByKey organizasyon icinde arama yapiyor, yani ayni
 * org'daki BASKA bir projenin karti da donebilir. Bir depo yalnizca kendi
 * projesinin kartlarini tasiyabilmeli - aksi halde bir repoya webhook kurma
 * yetkisi olan kisi, org'daki diger projelerin kartlarini commit mesajina
 * anahtar yazarak oynatabilirdi.
 */
async function anahtarlariKartaCoz(link: GithubRepoLink, anahtarlar: string[]) {
  const proje = await prisma.project.findUnique({
    where: { id: link.projectId },
    select: { organizationId: true, key: true },
  });
  if (!proje) return [];

  const kartlar: { id: string; title: string; anahtar: string }[] = [];

  for (const anahtar of anahtarlar) {
    const ayrilmis = parseCardKey(anahtar);
    // Baska projenin onekini tasiyan anahtar icin sorgu bile atmiyoruz.
    if (!ayrilmis || ayrilmis.projectKey !== proje.key) continue;

    const card = await prisma.card.findFirst({
      where: {
        number: ayrilmis.number,
        // Kartin projesini DOGRUDAN sart kosuyoruz: yukaridaki key kontrolu
        // ile birlikte ikinci savunma hatti.
        column: { projectId: link.projectId },
      },
      select: { id: true, title: true, isArchived: true },
    });
    // Arsivlenmis kart panoda gorunmuyor; PR merge'i onu geri diriltmemeli.
    if (!card || card.isArchived) continue;

    kartlar.push({ id: card.id, title: card.title, anahtar });
  }

  return kartlar;
}

/**
 * GitHub kullanicisini Quantro kullanicisina esler.
 *
 * githubUsername profil senkronundan doluyor (github.service.ts). Eslesme
 * bulunamazsa - ki cogu durumda bulunamaz, kullanicilarin cogu GitHub'ini
 * baglamamis olabilir - baglantiyi kuran kisiye dusuluyor. Otomasyondaki
 * "aksiyonu tetikleyen = kurali kuran kisi" mantiginin aynisi: denetim izinin
 * bir kimlige baglanmasi sart, kimligin dogru insan olmasi ise en iyi caba.
 */
async function aktoruCoz(link: GithubRepoLink, githubLogin: string | undefined): Promise<string> {
  if (!githubLogin) return link.createdById;

  const proje = await prisma.project.findUnique({
    where: { id: link.projectId },
    select: { organizationId: true },
  });
  if (!proje) return link.createdById;

  const kullanici = await prisma.user.findFirst({
    where: {
      githubUsername: { equals: githubLogin, mode: "insensitive" },
      // Org uyeligi SART: eslesen kisi organizasyondan cikarilmis olabilir ve
      // aktivite kaydi ile bildirimler kart basligini tasiyor. Otomasyondaki
      // ASSIGN_USER kontrolunun aynisi.
      organizationMemberships: { some: { organizationId: proje.organizationId } },
    },
    select: { id: true },
  });

  return kullanici?.id ?? link.createdById;
}

/** Kart <-> branch/PR bagini yazar; ayni bag ikinci kez gelirse gunceller. */
async function bagiKaydet(input: {
  cardId: string;
  repoLinkId: string;
  kind: GithubLinkKind;
  reference: string;
  title: string | null;
  url: string;
  state: string | null;
  authorLogin: string | null;
}) {
  const { cardId, repoLinkId, kind, reference, ...veri } = input;
  await prisma.githubCardLink.upsert({
    where: {
      repoLinkId_kind_reference_cardId: { repoLinkId, kind, reference, cardId },
    },
    create: { cardId, repoLinkId, kind, reference, ...veri },
    // Durum degisir (open -> merged), baslik duzenlenebilir.
    update: veri,
  });
}

export interface OlayIslemeSonucu {
  islendi: boolean;
  /** Bilgi amacli: hangi kartlar tasindi. */
  tasinanKartlar: string[];
  /** Tekrar teslimat, ilgisiz olay vb. durumlarda sebep. */
  not?: string;
}

// GitHub yuk sekillerinden YALNIZCA kullandigimiz alanlar. Tam tip yerine
// dar arayuz: kullanmadigimiz yuzlerce alani tiplemek bakim yuku olurdu.
interface PushYuku {
  ref?: string;
  deleted?: boolean;
  commits?: { message?: string }[];
  repository?: { default_branch?: string; html_url?: string };
  sender?: { login?: string };
}

interface PullRequestYuku {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string;
    html_url?: string;
    merged?: boolean;
    state?: string;
    head?: { ref?: string };
    user?: { login?: string };
  };
  repository?: { html_url?: string };
  sender?: { login?: string };
}

/**
 * Teslimati tekillestirir. GitHub 2xx alamadigi teslimatlari yeniden deniyor
 * ve kullanici webhook ekranindan elle "Redeliver" diyebiliyor; koruma
 * olmadan ayni merge karti tekrar tasiyip ikinci bildirimi uretirdi.
 *
 * @returns daha once islenmisse false
 */
async function teslimatiKaydet(repoLinkId: string, deliveryId: string, event: string): Promise<boolean> {
  try {
    await prisma.githubWebhookEvent.create({ data: { repoLinkId, deliveryId, event } });
    return true;
  } catch (error) {
    // P2002 = benzersizlik ihlali, yani bu teslimat zaten islenmis.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

export async function handleEvent(input: {
  link: GithubRepoLink;
  event: string;
  deliveryId: string;
  payload: unknown;
}): Promise<OlayIslemeSonucu> {
  const { link, event, deliveryId, payload } = input;

  // GitHub webhook'u kaydederken bir kez "ping" atiyor; kullanicinin kurulum
  // ekraninda yesil tik gormesi icin basariyla donmeli.
  if (event === "ping") return { islendi: true, tasinanKartlar: [], not: "ping" };
  if (event !== "push" && event !== "pull_request") {
    return { islendi: false, tasinanKartlar: [], not: `desteklenmeyen olay: ${event}` };
  }

  if (!(await teslimatiKaydet(link.id, deliveryId, event))) {
    return { islendi: false, tasinanKartlar: [], not: "tekrar teslimat" };
  }

  return event === "push"
    ? pushIsle(link, payload as PushYuku)
    : pullRequestIsle(link, payload as PullRequestYuku);
}

async function pushIsle(link: GithubRepoLink, yuk: PushYuku): Promise<OlayIslemeSonucu> {
  const branch = branchAdiCikar(yuk.ref);
  if (!branch) return { islendi: false, tasinanKartlar: [], not: "dal push'u degil" };
  // Dal silindiginde de push olayi geliyor; silinen dal icin is baslatilmaz.
  if (yuk.deleted) return { islendi: false, tasinanKartlar: [], not: "dal silinmis" };

  // Varsayilan dala yapilan push "isi baslatti" demek DEGIL - tam tersi,
  // genelde isin bittigi (merge edildigi) an. Kartlari "In Progress"e geri
  // cekmemek icin atlaniyor; merge'in kendisi pull_request olayindan geliyor.
  if (yuk.repository?.default_branch && branch === yuk.repository.default_branch) {
    return { islendi: false, tasinanKartlar: [], not: "varsayilan dal" };
  }

  const commitMesajlari = (yuk.commits ?? []).slice(0, MAKS_COMMIT).map((c) => c.message);
  const anahtarlar = extractCardKeys(branch, ...commitMesajlari);
  if (anahtarlar.length === 0) return { islendi: false, tasinanKartlar: [], not: "anahtar yok" };

  const kartlar = await anahtarlariKartaCoz(link, anahtarlar);
  if (kartlar.length === 0) return { islendi: false, tasinanKartlar: [], not: "kart bulunamadi" };

  const aktorUserId = await aktoruCoz(link, yuk.sender?.login);
  const branchUrl = yuk.repository?.html_url
    ? `${yuk.repository.html_url}/tree/${encodeURI(branch)}`
    : `https://github.com/${link.owner}/${link.repo}/tree/${encodeURI(branch)}`;

  const tasinanlar: string[] = [];
  for (const kart of kartlar) {
    await bagiKaydet({
      cardId: kart.id,
      repoLinkId: link.id,
      kind: "BRANCH",
      reference: branch,
      title: null,
      url: branchUrl,
      state: null,
      authorLogin: yuk.sender?.login ?? null,
    });

    // Kolon eslenmemisse bag yine kaydedildi, sadece tasima yapilmiyor.
    if (!link.branchColumnId) continue;
    const sonuc = await sistemKartTasi({
      cardId: kart.id,
      hedefColumnId: link.branchColumnId,
      projectId: link.projectId,
      aktorUserId,
      kaynakEtiketi: "github:push",
    });
    if (sonuc.tasindi) tasinanlar.push(kart.anahtar);
  }

  return { islendi: true, tasinanKartlar: tasinanlar };
}

async function pullRequestIsle(link: GithubRepoLink, yuk: PullRequestYuku): Promise<OlayIslemeSonucu> {
  const pr = yuk.pull_request;
  if (!pr?.number) return { islendi: false, tasinanKartlar: [], not: "PR yuku eksik" };

  const action = yuk.action ?? "";
  const merged = pr.merged === true;

  // Hangi aksiyonda nereye tasinacagi:
  //   opened/reopened/ready_for_review -> "inceleme" kolonu
  //   closed + merged                  -> "bitti" kolonu
  //   closed + merge YOK               -> tasima yok, is geri alinmis olabilir
  //                                       ama nereye gidecegi belirsiz; kararı
  //                                       insana birakiyoruz, yalnizca durumu
  //                                       guncelliyoruz.
  let hedefColumnId: string | null = null;
  if (action === "opened" || action === "reopened" || action === "ready_for_review") {
    hedefColumnId = link.prOpenColumnId;
  } else if (action === "closed" && merged) {
    hedefColumnId = link.prMergedColumnId;
  } else if (action !== "closed" && action !== "edited" && action !== "synchronize") {
    // assigned/labeled/review_requested gibi olaylar kart durumunu degistirmez.
    return { islendi: false, tasinanKartlar: [], not: `ilgisiz aksiyon: ${action}` };
  }

  const anahtarlar = extractCardKeys(pr.head?.ref, pr.title, pr.body);
  if (anahtarlar.length === 0) return { islendi: false, tasinanKartlar: [], not: "anahtar yok" };

  const kartlar = await anahtarlariKartaCoz(link, anahtarlar);
  if (kartlar.length === 0) return { islendi: false, tasinanKartlar: [], not: "kart bulunamadi" };

  const aktorUserId = await aktoruCoz(link, pr.user?.login ?? yuk.sender?.login);
  const prUrl = pr.html_url ?? `https://github.com/${link.owner}/${link.repo}/pull/${pr.number}`;

  const tasinanlar: string[] = [];
  for (const kart of kartlar) {
    await bagiKaydet({
      cardId: kart.id,
      repoLinkId: link.id,
      kind: "PULL_REQUEST",
      reference: String(pr.number),
      title: pr.title ?? null,
      url: prUrl,
      // GitHub merge edilmis PR'i da "closed" olarak bildiriyor; merge ile
      // reddedilmis kapanisi ayirt edebilmek icin ayri deger yaziyoruz.
      state: merged ? "merged" : (pr.state ?? null),
      authorLogin: pr.user?.login ?? null,
    });

    if (!hedefColumnId) continue;
    const sonuc = await sistemKartTasi({
      cardId: kart.id,
      hedefColumnId,
      projectId: link.projectId,
      aktorUserId,
      kaynakEtiketi: `github:pr-${action}`,
    });
    if (sonuc.tasindi) tasinanlar.push(kart.anahtar);
  }

  return { islendi: true, tasinanKartlar: tasinanlar };
}
