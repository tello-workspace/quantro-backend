import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import * as cardService from "@/services/card.service";
import * as projectService from "@/services/project.service";
import * as searchService from "@/services/search.service";
import {
  formatCardKey,
  parseCardKey,
  suggestProjectKey,
  allocateCardNumber,
  findCardByKey,
} from "@/services/card-key.service";
import { createWorkspace, cleanup } from "@/test/fixtures";

const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await cleanup({ orgIds, userIds });
});

describe("kart anahtari - saf fonksiyonlar", () => {
  it("cok kelimeli proje adindan bas harfleri alir", () => {
    expect(suggestProjectKey("Quantro Backend")).toBe("QB");
    expect(suggestProjectKey("E-Ticaret Yenileme Projesi")).toBe("ETYP");
  });

  it("tek kelimeli addan ilk 3 harfi alir", () => {
    expect(suggestProjectKey("Quantro")).toBe("QUA");
  });

  it("Turkce karakterleri ASCII karsiligina indirger", () => {
    // Harf filtresi ham haliyle 'Ö' ve 'Ş'yi duserdi ve anahtar bosalirdi.
    expect(suggestProjectKey("Ödeme")).toBe("ODE");
    expect(suggestProjectKey("Şirket İçi")).toBe("SI");
  });

  it("hic harf yoksa PRJ'ye duser", () => {
    expect(suggestProjectKey("123 456")).toBe("PRJ");
  });

  it("anahtari ayristirir ve buyuk harfe cevirir", () => {
    expect(parseCardKey("QNT-42")).toEqual({ projectKey: "QNT", number: 42 });
    expect(parseCardKey("  qnt-7 ")).toEqual({ projectKey: "QNT", number: 7 });
  });

  it("gecersiz bicimleri reddeder", () => {
    expect(parseCardKey("QNT")).toBeNull();
    expect(parseCardKey("QNT-0")).toBeNull(); // numaralar 1'den baslar
    expect(parseCardKey("Q-1")).toBeNull(); // en az 2 karakterlik onek
    expect(parseCardKey("QNT-abc")).toBeNull();
    expect(parseCardKey("cmseoy21m008xlx2lidnwavf2")).toBeNull();
  });

  it("formatlar", () => {
    expect(formatCardKey("QNT", 42)).toBe("QNT-42");
  });
});

describe("kart anahtari - numara ayirma", () => {
  it("ardisik kartlar ardisik numara alir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const ilk = await cardService.createCard(ws.todo.id, { title: "Ilk" }, ws.admin.id);
    const ikinci = await cardService.createCard(ws.todo.id, { title: "Ikinci" }, ws.admin.id);

    expect(ikinci.number).toBe(ilk.number + 1);
  });

  it("es zamanli olusturmada ayni numara iki kez verilmez", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    // Sayac atomik olarak +1'lendigi icin paralel istekler carpismamali.
    //
    // 5 ile sinirli: uretim havuzu pool_size=15 ve testler ayni havuzu
    // kullaniyor - daha yuksek eszamanlilik ozelligi degil altyapiyi test
    // eder ve "max clients reached" ile patlar (bkz. Suggestions'taki
    // baglanti havuzu karti).
    const numaralar = await Promise.all(
      Array.from({ length: 5 }, () => allocateCardNumber(ws.project.id)),
    );

    expect(new Set(numaralar).size).toBe(5);
  });

  it("silinen kartin numarasi geri kullanilmaz", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await cardService.createCard(ws.todo.id, { title: "Silinecek" }, ws.admin.id);
    await prisma.card.delete({ where: { id: kart.id } });

    const sonraki = await cardService.createCard(ws.todo.id, { title: "Sonraki" }, ws.admin.id);
    expect(sonraki.number).toBe(kart.number + 1);
  });
});

describe("kart anahtari - proje anahtari", () => {
  it("proje olustururken addan anahtar uretilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const proje = await projectService.createProject(
      ws.org.id,
      { name: "Mobil Uygulama" },
      ws.admin.id,
    );

    expect(proje.key).toBe("MU");
  });

  it("ayni org'da anahtar cakisirsa sayi eklenir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const ilk = await projectService.createProject(
      ws.org.id,
      { name: "Alfa Beta" },
      ws.admin.id,
    );
    const ikinci = await projectService.createProject(
      ws.org.id,
      { name: "Ana Bilgi" },
      ws.admin.id,
    );

    expect(ilk.key).toBe("AB");
    expect(ikinci.key).toBe("AB2");
  });

  it("kullanicinin verdigi anahtar buyuk harfe cevrilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const proje = await projectService.createProject(
      ws.org.id,
      { name: "Herhangi", key: "web" },
      ws.admin.id,
    );

    expect(proje.key).toBe("WEB");
  });

  it("gecersiz anahtar reddedilir", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    await expect(
      projectService.createProject(ws.org.id, { name: "Herhangi", key: "1AB" }, ws.admin.id),
    ).rejects.toThrow();
  });
});

describe("kart anahtari - arama ve adresleme", () => {
  it("anahtarla kart bulunur", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await cardService.createCard(ws.todo.id, { title: "Aranan" }, ws.admin.id);
    const anahtar = formatCardKey("TST", kart.number);

    const bulunan = await findCardByKey(ws.org.id, anahtar);
    expect(bulunan?.id).toBe(kart.id);
  });

  it("baska organizasyonun anahtari bulunmaz", async () => {
    const ws = await createWorkspace();
    const digerWs = await createWorkspace();
    orgIds.push(ws.org.id, digerWs.org.id);
    userIds.push(
      ws.admin.id, ws.member.id, ws.outsider.id,
      digerWs.admin.id, digerWs.member.id, digerWs.outsider.id,
    );

    const kart = await cardService.createCard(ws.todo.id, { title: "Gizli" }, ws.admin.id);
    const anahtar = formatCardKey("TST", kart.number);

    // Iki workspace'de de proje anahtari "TST" ama org sinirini asmamali.
    const bulunan = await findCardByKey(digerWs.org.id, anahtar);
    expect(bulunan?.id).not.toBe(kart.id);
  });

  it("aramaya anahtar yazilinca tek sonuc olarak o kart doner", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    // Baslikta anahtar GECMIYOR - duz metin aramasi bunu bulamazdi.
    const kart = await cardService.createCard(
      ws.todo.id,
      { title: "Tamamen alakasiz bir baslik" },
      ws.admin.id,
    );
    const anahtar = formatCardKey("TST", kart.number);

    const sonuc = await searchService.searchOrganization(ws.org.id, ws.admin.id, anahtar);
    expect(sonuc.cards).toHaveLength(1);
    expect(sonuc.cards[0].id).toBe(kart.id);
    expect(sonuc.cards[0].cardKey).toBe(anahtar);
  });

  it("metin aramasi sonuclarinda anahtar da doner", async () => {
    const ws = await createWorkspace();
    orgIds.push(ws.org.id);
    userIds.push(ws.admin.id, ws.member.id, ws.outsider.id);

    const kart = await cardService.createCard(
      ws.todo.id,
      { title: "Benzersiz kelime zurafa" },
      ws.admin.id,
    );

    const sonuc = await searchService.searchOrganization(ws.org.id, ws.admin.id, "zurafa");
    const satir = sonuc.cards.find((c) => c.id === kart.id);
    expect(satir?.cardKey).toBe(formatCardKey("TST", kart.number));
  });
});
