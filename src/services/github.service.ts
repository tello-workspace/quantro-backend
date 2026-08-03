import { AppError, ValidationError } from "@/utils/errors";

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
      // Kimliksiz istekte saatlik 60 sinir var; kullaniciya "sonra dene"
      // demek, anlamsiz bir hata gostermekten iyi.
      throw new AppError(429, "GitHub istek sınırına takıldı, biraz sonra tekrar deneyin", "RATE_LIMITED");
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

  return {
    username: user.login,
    name: user.name,
    bio: user.bio,
    avatarUrl: user.avatar_url,
    company: user.company,
    location: user.location,
    publicRepos: user.public_repos,
    languages,
  };
}
