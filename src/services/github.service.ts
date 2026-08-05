import { prisma } from "@/lib/prisma";
import { AppError, ValidationError } from "@/utils/errors";
import { invalidateUserCache } from "@/middleware/auth";

// GitHub profil senkronu. Kullanicinin kendi beyanina (elle yazdigi uzmanlik
// alanlari) guvenmek yerine gercek repo verisinden turetiyoruz - yetkinlik
// bazli otomatik atama (bkz. ai.service buildSystemPrompt) bu alanlari
// kullaniyor ve gercek veri tahminden her zaman daha isabetli.

// SSRF'e karsi: kullanicinin verdigi URL'i ASLA dogrudan fetch etmiyoruz.
// Yalnizca kullanici adini cikarip api.github.com uzerinde kendi
// kurdugumuz adresi cagiriyoruz. Aksi halde profil alanina bir ic ag adresi
// yazip sunucuyu ona istek atmaya zorlamak mumkun olurdu.
const GITHUB_URL_DESENI = /^https?:\/\/(www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/?$/;

export function extractGithubUsername(url: string): string | null {
  const eslesme = GITHUB_URL_DESENI.exec(url.trim());
  return eslesme ? eslesme[2] : null;
}

interface GithubUser {
  login: string;
  name: string | null;
  bio: string | null;
  avatar_url: string | null;
  company: string | null;
  location: string | null;
  public_repos: number;
}

interface GithubRepo {
  language: string | null;
  fork: boolean;
  stargazers_count: number;
}

const ISTEK_ZAMAN_ASIMI_MS = 8000;

// Kimliksiz GitHub istegi IP basina saatte 60 ile sinirli ve Render'da cikis
// IP'si PAYLASIMLI - kotayi ayni makinedeki diger kiracilar da tuketiyor.
// Pratikte bu, token olmadan ozelligin calismayabilecegi anlamina geliyor.
// Onbellek tek basina cozmuyor ama ayni profili tekrar tekrar sorgulamayi
// (kullanicinin butona birkac kez basmasi tipik) kotadan dusurmuyor.
const ONBELLEK_TTL_MS = 30 * 60 * 1000;
const onbellek = new Map<string, { veri: GithubProfileOzeti; zaman: number }>();

function onbellektenOku(username: string): GithubProfileOzeti | null {
  const kayit = onbellek.get(username.toLowerCase());
  if (!kayit) return null;
  if (Date.now() - kayit.zaman > ONBELLEK_TTL_MS) {
    onbellek.delete(username.toLowerCase());
    return null;
  }
  return kayit.veri;
}

async function githubGet<T>(yol: string): Promise<T> {
  const controller = new AbortController();
  const zamanlayici = setTimeout(() => controller.abort(), ISTEK_ZAMAN_ASIMI_MS);

  try {
    const res = await fetch(`https://api.github.com${yol}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Quantro",
        // Token varsa saatlik limit 60'tan 5000'e cikar. Yoksa da calisir,
        // sadece sik senkronda limite takilabilir.
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: controller.signal,
    });

    if (res.status === 404) {
      throw new AppError(404, "GitHub kullanıcısı bulunamadı", "NOT_FOUND");
    }
    if (res.status === 403 || res.status === 429) {
      // Mesaji sebebe gore ayiriyoruz: token yokken limit 60/saat ve Render'in
      // cikis IP'si paylasimli oldugu icin kota cogu zaman bizim disimizda
      // tukeniyor. "Biraz sonra dene" demek bu durumda yaniltici - beklemek
      // cozmuyor, token eklemek cozuyor.
      const tokenVar = !!process.env.GITHUB_TOKEN;
      const sifirlanma = res.headers.get("x-ratelimit-reset");
      const dakika = sifirlanma
        ? Math.max(1, Math.ceil((Number(sifirlanma) * 1000 - Date.now()) / 60000))
        : null;

      throw new AppError(
        429,
        tokenVar
          ? `GitHub istek sınırına takıldı${dakika ? `, ${dakika} dakika sonra tekrar deneyin` : ", biraz sonra tekrar deneyin"}`
          : "GitHub istek sınırına takıldı. Sunucuda GITHUB_TOKEN tanımlı olmadığı için saatlik limit çok düşük (60) ve paylaşımlı IP üzerinden tükeniyor. Yöneticinizin GITHUB_TOKEN eklemesi gerekiyor.",
        "RATE_LIMITED",
      );
    }
    if (!res.ok) {
      throw new AppError(502, "GitHub'a ulaşılamadı", "UPSTREAM_ERROR");
    }

    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error)?.name === "AbortError") {
      throw new AppError(504, "GitHub yanıt vermedi", "TIMEOUT");
    }
    throw new AppError(502, "GitHub'a ulaşılamadı", "UPSTREAM_ERROR");
  } finally {
    clearTimeout(zamanlayici);
  }
}

export interface GithubProfileOzeti {
  username: string;
  name: string | null;
  bio: string | null;
  avatarUrl: string | null;
  company: string | null;
  location: string | null;
  publicRepos: number;
  /** Repolardan turetilen diller, en cok kullanilandan az kullanilana */
  languages: string[];
}

export async function fetchGithubProfile(githubUrl: string): Promise<GithubProfileOzeti> {
  const username = extractGithubUsername(githubUrl);
  if (!username) {
    throw new ValidationError("Geçerli bir GitHub profil adresi girin (https://github.com/kullanici)");
  }

  const onbellekli = onbellektenOku(username);
  if (onbellekli) return onbellekli;

  const [user, repos] = await Promise.all([
    githubGet<GithubUser>(`/users/${username}`),
    // sort=pushed: kullanicinin SON dokundugu repolar. Yildiz sayisina gore
    // siralamak eski/populer bir projeyi one cikarirdi; biz "bugunlerde ne
    // yaziyor" bilgisini istiyoruz.
    githubGet<GithubRepo[]>(`/users/${username}/repos?sort=pushed&per_page=100`),
  ]);

  // Fork'lar sayilmiyor: baskasinin projesini fork'lamak o dili bildigini
  // gostermez ve tipik olarak profildeki en kalabalik kategoridir.
  const dilSayaci = new Map<string, number>();
  for (const repo of repos) {
    if (repo.fork || !repo.language) continue;
    dilSayaci.set(repo.language, (dilSayaci.get(repo.language) ?? 0) + 1);
  }

  const languages = [...dilSayaci.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dil]) => dil);

  const ozet: GithubProfileOzeti = {
    username: user.login,
    name: user.name,
    bio: user.bio,
    avatarUrl: user.avatar_url,
    company: user.company,
    location: user.location,
    publicRepos: user.public_repos,
    languages,
  };

  onbellek.set(username.toLowerCase(), { veri: ozet, zaman: Date.now() });
  return ozet;
}

/** Senkronun neyi yazdigini, neye dokunmadigini cagirana anlatir. */
export interface GithubSenkronSonucu {
  profil: GithubProfileOzeti;
  /** Kaydedilen alan adlari - kullaniciya "ne oldu" diyebilmek icin. */
  yazilan: string[];
  /** Dolu oldugu icin korunan alanlar. */
  korunan: string[];
}

/**
 * GitHub profilini ceker ve KAYDEDER.
 *
 * Onceden bu islem yalnizca okuyup formu dolduruyordu ve gelen 8 alanin
 * yalnizca 2'si (bio, languages) forma giriyordu; kalan 6'si atiliyordu.
 * Kullanici "Kaydet"e basmadigi surece de hicbir sey kalici olmuyordu.
 *
 * Yazma politikasi alanin SAHIBINE gore degisiyor:
 *
 * - GitHub'a ait olgular (kullanici adi, sirket, konum, repo sayisi) her
 *   senkronda uzerine yaziliyor. Bunlarin kullanici girdisi karsiligi yok,
 *   dolayisiyla ezilecek bir sey de yok.
 * - Kullanicinin kendi yazdigi alanlar (bio, avatar) yalnizca BOSSA
 *   dolduruluyor. Elle yazilmis bir bio'yu GitHub'daki tek satirlik metinle
 *   degistirmek bilgi kaybi olurdu.
 * - Diller birlestiriliyor: GitHub yalnizca repo dillerini biliyor; kullanici
 *   SQL/Docker gibi repo dili olarak gorunmeyen seyler eklemis olabilir.
 * - Isim hic ellenmiyor: zorunlu alan ve kullanicinin kendi secimi.
 */
export interface MevcutProfil {
  bio: string | null;
  avatarUrl: string | null;
  languages: string[];
}

/**
 * Yazma politikasini uygular. AG ERISIMI YOK ve veritabanina dokunmuyor -
 * saf bir fonksiyon, bu yuzden dogrudan test edilebiliyor. Politikanin dogru
 * olmasi bu ozelligin en kritik parcasi: hatasi sessizce veri kaybi demek.
 */
export function senkronVerisiHazirla(profil: GithubProfileOzeti, mevcut: MevcutProfil) {
  const yazilan: string[] = [];
  const korunan: string[] = [];

  const veri: Record<string, unknown> = {
    githubUrl: `https://github.com/${profil.username}`,
    githubUsername: profil.username,
    company: profil.company,
    location: profil.location,
    publicRepos: profil.publicRepos,
    githubSyncedAt: new Date(),
  };
  yazilan.push("GitHub kullanıcı adı");
  if (profil.company) yazilan.push("şirket");
  if (profil.location) yazilan.push("konum");
  yazilan.push("repo sayısı");

  if (profil.bio) {
    if (mevcut.bio?.trim()) korunan.push("biyografi");
    else {
      veri.bio = profil.bio;
      yazilan.push("biyografi");
    }
  }

  if (profil.avatarUrl) {
    if (mevcut.avatarUrl) korunan.push("profil fotoğrafı");
    else {
      veri.avatarUrl = profil.avatarUrl;
      yazilan.push("profil fotoğrafı");
    }
  }

  if (profil.languages.length > 0) {
    const birlesik = [...new Set([...mevcut.languages, ...profil.languages])].slice(0, 20);
    if (birlesik.length !== mevcut.languages.length) {
      veri.languages = birlesik;
      yazilan.push(`${birlesik.length - mevcut.languages.length} yeni dil`);
    }
  }

  return { veri, yazilan, korunan };
}

export async function syncGithubProfileToUser(
  userId: string,
  githubUrl: string,
): Promise<GithubSenkronSonucu> {
  const profil = await fetchGithubProfile(githubUrl);

  const mevcut = await prisma.user.findUnique({
    where: { id: userId },
    select: { bio: true, avatarUrl: true, languages: true },
  });
  if (!mevcut) throw new AppError(404, "Kullanıcı bulunamadı", "NOT_FOUND");

  const { veri, yazilan, korunan } = senkronVerisiHazirla(profil, mevcut);

  await prisma.user.update({ where: { id: userId }, data: veri });

  // auth middleware kullaniciyi 30 saniye onbellekliyor; isim/e-posta
  // degismedi ama tutarli olmak icin dusuruyoruz.
  invalidateUserCache(userId);

  return { profil, yazilan, korunan };
}
