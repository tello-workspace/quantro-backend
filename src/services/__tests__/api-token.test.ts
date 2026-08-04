import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
  TOKEN_ONEKI,
} from "@/services/api-token.service";

// API anahtari, MCP server'in tum yetkisini tasiyan tek sey - bu yuzden
// testler "calisiyor mu" degil, "yanlis kullanildiginda REDDEDIYOR mu"
// sorusuna odakli: iptal edilen anahtar, baskasinin anahtari, DB'de ham
// token'in bulunmamasi.

let kullaniciA: string;
let kullaniciB: string;

beforeAll(async () => {
  const damga = crypto.randomBytes(6).toString("hex");
  const a = await prisma.user.create({
    data: {
      name: "Token Test A",
      email: `token-a-${damga}@test.local`,
      passwordHash: "x",
    },
    select: { id: true },
  });
  const b = await prisma.user.create({
    data: {
      name: "Token Test B",
      email: `token-b-${damga}@test.local`,
      passwordHash: "x",
    },
    select: { id: true },
  });
  kullaniciA = a.id;
  kullaniciB = b.id;
});

afterAll(async () => {
  // beforeAll patlarsa bu id'ler undefined kalir ve temizlik ikinci bir
  // hata firlatip ASIL hatayi ciktida gomer. Filtreleyip sessizce geciyoruz.
  const idler = [kullaniciA, kullaniciB].filter(Boolean);
  if (idler.length === 0) return;
  // ApiToken'lar onDelete: Cascade ile birlikte gidiyor.
  await prisma.user.deleteMany({ where: { id: { in: idler } } });
});

describe("createApiToken", () => {
  it("on ekli ham token uretir ve sahibini dogrular", async () => {
    const olusan = await createApiToken(kullaniciA, "MCP dizustu");

    expect(olusan.token.startsWith(TOKEN_ONEKI)).toBe(true);
    expect(olusan.name).toBe("MCP dizustu");

    const sahip = await verifyApiToken(olusan.token);
    expect(sahip?.id).toBe(kullaniciA);
  });

  it("HAM tokeni veritabaninda saklamaz", async () => {
    // Bu testin amaci: DB'yi goren biri (yedek, log, destek erisimi)
    // kimsenin hesabina baglanamamali.
    const olusan = await createApiToken(kullaniciA, "sizinti kontrolu");

    const kayit = await prisma.apiToken.findUnique({
      where: { id: olusan.id },
      select: { tokenHash: true, prefix: true },
    });

    expect(kayit!.tokenHash).not.toBe(olusan.token);
    expect(kayit!.tokenHash).toBe(
      crypto.createHash("sha256").update(olusan.token).digest("hex"),
    );
    // On ek duz metin ama tek basina ise yaramaz - tokenin tamami degil.
    expect(olusan.token.startsWith(kayit!.prefix)).toBe(true);
    expect(kayit!.prefix.length).toBeLessThan(olusan.token.length);
  });

  it("her cagride farkli token uretir", async () => {
    const bir = await createApiToken(kullaniciA, "bir");
    const iki = await createApiToken(kullaniciA, "iki");
    expect(bir.token).not.toBe(iki.token);
  });

  it("bos ad reddeder", async () => {
    await expect(createApiToken(kullaniciA, "   ")).rejects.toThrow(/ad/i);
  });
});

describe("verifyApiToken", () => {
  it("uydurma tokeni reddeder", async () => {
    const sahte = `${TOKEN_ONEKI}${crypto.randomBytes(32).toString("hex")}`;
    expect(await verifyApiToken(sahte)).toBeNull();
  });

  it("on eki olmayan degeri reddeder", async () => {
    // JWT'ler buraya hic dusmemeli; dusse bile eslesme olmamali.
    expect(await verifyApiToken("eyJhbGciOiJIUzI1NiJ9.abc.def")).toBeNull();
    expect(await verifyApiToken("")).toBeNull();
  });

  it("iptal edilen tokeni reddeder", async () => {
    const olusan = await createApiToken(kullaniciA, "iptal edilecek");
    expect(await verifyApiToken(olusan.token)).not.toBeNull();

    await revokeApiToken(kullaniciA, olusan.id);
    expect(await verifyApiToken(olusan.token)).toBeNull();
  });

  it("kullanildiginda lastUsedAt isaretler", async () => {
    const olusan = await createApiToken(kullaniciA, "kullanim izi");
    expect(olusan.lastUsedAt).toBeNull();

    await verifyApiToken(olusan.token);

    // Guncelleme bilerek beklenmiyor (fire-and-forget) - yazmanin
    // tamamlanmasina kisa bir pay birakiyoruz.
    await new Promise((r) => setTimeout(r, 500));
    const kayit = await prisma.apiToken.findUnique({
      where: { id: olusan.id },
      select: { lastUsedAt: true },
    });
    expect(kayit!.lastUsedAt).not.toBeNull();
  });
});

describe("revokeApiToken", () => {
  it("BASKASININ anahtarini iptal ettirmez", async () => {
    // Yetki kontrolu olmasa, id tahmin eden biri baskasinin MCP baglantisini
    // kesebilirdi.
    const olusan = await createApiToken(kullaniciA, "A'nin anahtari");

    await expect(revokeApiToken(kullaniciB, olusan.id)).rejects.toThrow();
    expect(await verifyApiToken(olusan.token)).not.toBeNull();
  });

  it("ayni anahtari iki kez iptal etmeyi reddeder", async () => {
    const olusan = await createApiToken(kullaniciA, "cift iptal");
    await revokeApiToken(kullaniciA, olusan.id);
    await expect(revokeApiToken(kullaniciA, olusan.id)).rejects.toThrow();
  });
});

describe("listApiTokens", () => {
  it("yalnizca kendi aktif anahtarlarini listeler ve ham token sizdirmaz", async () => {
    const bAnahtari = await createApiToken(kullaniciB, "B'nin anahtari");
    const iptalli = await createApiToken(kullaniciB, "B'nin iptallisi");
    await revokeApiToken(kullaniciB, iptalli.id);

    const liste = await listApiTokens(kullaniciB);
    const idler = liste.map((t) => t.id);

    expect(idler).toContain(bAnahtari.id);
    expect(idler).not.toContain(iptalli.id);

    // Listede ham token veya hash asla bulunmamali.
    const serilestirilmis = JSON.stringify(liste);
    expect(serilestirilmis).not.toContain(bAnahtari.token);
    expect(serilestirilmis).not.toContain("tokenHash");
  });

  it("baska kullanicinin anahtarlarini gostermez", async () => {
    const liste = await listApiTokens(kullaniciB);
    const aListesi = await listApiTokens(kullaniciA);
    const bIdleri = new Set(liste.map((t) => t.id));
    expect(aListesi.some((t) => bIdleri.has(t.id))).toBe(false);
  });
});
