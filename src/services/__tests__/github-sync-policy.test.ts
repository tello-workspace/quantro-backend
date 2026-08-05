import { describe, it, expect } from "vitest";
import { senkronVerisiHazirla, type GithubProfileOzeti, type MevcutProfil } from "@/services/github.service";

// GitHub senkronu artik KAYDEDIYOR. Yazma politikasinin dogru olmasi bu
// ozelligin en kritik parcasi: hatasi sessizce veri kaybi demek - kullanicinin
// elle yazdigi biyografi veya yukledigi avatar GitHub verisiyle ezilirse geri
// donusu yok. Bu testler politikayi AGA CIKMADAN dogruluyor.

const profil = (ek: Partial<GithubProfileOzeti> = {}): GithubProfileOzeti => ({
  username: "torvalds",
  name: "Linus",
  bio: "GitHub'daki bio",
  avatarUrl: "https://github/avatar.png",
  company: "Linux Foundation",
  location: "Portland, OR",
  publicRepos: 12,
  languages: ["C", "Shell"],
  ...ek,
});

const bosProfil: MevcutProfil = { bio: null, avatarUrl: null, languages: [] };

describe("senkronVerisiHazirla", () => {
  it("GitHub'a ait olgulari her zaman yazar", () => {
    const { veri } = senkronVerisiHazirla(profil(), bosProfil);

    expect(veri.githubUsername).toBe("torvalds");
    expect(veri.company).toBe("Linux Foundation");
    expect(veri.location).toBe("Portland, OR");
    expect(veri.publicRepos).toBe(12);
    expect(veri.githubUrl).toBe("https://github.com/torvalds");
    expect(veri.githubSyncedAt).toBeInstanceOf(Date);
  });

  it("githubUrl kullanici adindan YENIDEN kuruluyor - girilen ham metin degil", () => {
    // SSRF korumasinin bir parcasi: kaydedilen adres her zaman bizim
    // urettigimiz kanonik adres oluyor.
    const { veri } = senkronVerisiHazirla(profil({ username: "octocat" }), bosProfil);
    expect(veri.githubUrl).toBe("https://github.com/octocat");
  });

  it("bos profilde biyografi ve avatar doldurulur", () => {
    const { veri, yazilan, korunan } = senkronVerisiHazirla(profil(), bosProfil);

    expect(veri.bio).toBe("GitHub'daki bio");
    expect(veri.avatarUrl).toBe("https://github/avatar.png");
    expect(yazilan).toContain("biyografi");
    expect(korunan).toHaveLength(0);
  });

  it("kullanicinin YAZDIGI biyografi ezilmez", () => {
    const { veri, korunan } = senkronVerisiHazirla(profil(), {
      ...bosProfil,
      bio: "Kendi yazdığım biyografi",
    });

    expect(veri.bio).toBeUndefined();
    expect(korunan).toContain("biyografi");
  });

  it("yalnizca bosluktan olusan biyografi dolu sayilmaz", () => {
    const { veri } = senkronVerisiHazirla(profil(), { ...bosProfil, bio: "   " });
    expect(veri.bio).toBe("GitHub'daki bio");
  });

  it("kullanicinin YUKLEDIGI avatar ezilmez", () => {
    const { veri, korunan } = senkronVerisiHazirla(profil(), {
      ...bosProfil,
      avatarUrl: "https://depo/benim-fotografim.png",
    });

    expect(veri.avatarUrl).toBeUndefined();
    expect(korunan).toContain("profil fotoğrafı");
  });

  it("diller BIRLESTIRILIR - repo dili olmayanlar silinmez", () => {
    // GitHub yalnizca repo dillerini biliyor; SQL/Docker gibi seyleri
    // kullanici elle eklemis olabilir ve onlari atmak bilgi kaybi olurdu.
    const { veri } = senkronVerisiHazirla(profil({ languages: ["C", "Shell"] }), {
      ...bosProfil,
      languages: ["SQL", "Docker"],
    });

    expect(veri.languages).toEqual(["SQL", "Docker", "C", "Shell"]);
  });

  it("ayni dil iki kez eklenmez", () => {
    const { veri } = senkronVerisiHazirla(profil({ languages: ["C", "SQL"] }), {
      ...bosProfil,
      languages: ["SQL"],
    });

    expect(veri.languages).toEqual(["SQL", "C"]);
  });

  it("yeni dil yoksa diller alanina hic dokunulmaz", () => {
    const { veri } = senkronVerisiHazirla(profil({ languages: ["C"] }), {
      ...bosProfil,
      languages: ["C"],
    });

    expect(veri.languages).toBeUndefined();
  });

  it("dil listesi 20 ile sinirli", () => {
    const cok = Array.from({ length: 30 }, (_, i) => `Dil${i}`);
    const { veri } = senkronVerisiHazirla(profil({ languages: cok }), bosProfil);
    expect((veri.languages as string[]).length).toBe(20);
  });

  it("GitHub'da bos olan alanlar null olarak yazilir - eski deger kalmaz", () => {
    // Kullanici GitHub'da sirketini sildiyse bizde de silinmeli, yoksa
    // profil kalici olarak yanlis bilgi gosterirdi.
    const { veri } = senkronVerisiHazirla(
      profil({ company: null, location: null }),
      bosProfil,
    );

    expect(veri.company).toBeNull();
    expect(veri.location).toBeNull();
  });

  it("isim ASLA degistirilmez", () => {
    // Zorunlu alan ve kullanicinin kendi secimi; GitHub'daki adiyla sessizce
    // degistirmek surpriz olurdu.
    const { veri } = senkronVerisiHazirla(profil({ name: "Linus Torvalds" }), bosProfil);
    expect(veri.name).toBeUndefined();
  });

  it("GitHub'da biyografi yoksa korunan/yazilan listesine girmez", () => {
    const { veri, yazilan, korunan } = senkronVerisiHazirla(profil({ bio: null }), bosProfil);

    expect(veri.bio).toBeUndefined();
    expect(yazilan).not.toContain("biyografi");
    expect(korunan).not.toContain("biyografi");
  });
});
