import { describe, it, expect } from "vitest";
import { extractGithubUsername } from "@/services/github.service";

// Kullanicinin verdigi URL sunucu tarafindan fetch ediliyor; bu yuzden
// yalnizca kullanici adini cikarip api.github.com uzerinde KENDI kurdugumuz
// adresi cagiriyoruz. Bu testler desenin ic ag adreslerini ve github.com
// taklidi alan adlarini gecirmedigini garanti ediyor - aksi halde profil
// alanina yazilan bir adres sunucuyu ic servislere istek atmaya zorlayabilir
// (SSRF).

describe("extractGithubUsername", () => {
  it("gecerli profil adresinden kullanici adini cikarir", () => {
    expect(extractGithubUsername("https://github.com/torvalds")).toBe("torvalds");
    expect(extractGithubUsername("http://github.com/torvalds")).toBe("torvalds");
    expect(extractGithubUsername("https://www.github.com/torvalds")).toBe("torvalds");
    expect(extractGithubUsername("https://github.com/torvalds/")).toBe("torvalds");
    expect(extractGithubUsername("  https://github.com/torvalds  ")).toBe("torvalds");
  });

  it("tire iceren gecerli kullanici adlarini kabul eder", () => {
    expect(extractGithubUsername("https://github.com/some-user")).toBe("some-user");
  });

  it("github.com taklidi alan adlarini reddeder", () => {
    expect(extractGithubUsername("https://github.com.evil.tr/torvalds")).toBeNull();
    expect(extractGithubUsername("https://notgithub.com/torvalds")).toBeNull();
    expect(extractGithubUsername("https://github.evil.com/torvalds")).toBeNull();
  });

  it("ic ag ve dosya adreslerini reddeder", () => {
    expect(extractGithubUsername("http://localhost:3000/admin")).toBeNull();
    expect(extractGithubUsername("http://169.254.169.254/latest/meta-data")).toBeNull();
    expect(extractGithubUsername("file:///etc/passwd")).toBeNull();
    expect(extractGithubUsername("http://10.0.0.1/")).toBeNull();
  });

  it("profil disi github yollarini reddeder", () => {
    // Repo veya ayar sayfasi bir profil degil; kabul etseydik yol
    // birlestirmede beklenmedik API adresleri olusabilirdi.
    expect(extractGithubUsername("https://github.com/torvalds/linux")).toBeNull();
    expect(extractGithubUsername("https://github.com/settings/profile")).toBeNull();
  });

  it("yol kacisi denemelerini reddeder", () => {
    expect(extractGithubUsername("https://github.com/../admin")).toBeNull();
    expect(extractGithubUsername("https://github.com/torvalds/../../x")).toBeNull();
  });

  it("bos ve bicimsiz girdileri reddeder", () => {
    expect(extractGithubUsername("")).toBeNull();
    expect(extractGithubUsername("torvalds")).toBeNull();
    expect(extractGithubUsername("https://github.com/")).toBeNull();
  });
});
