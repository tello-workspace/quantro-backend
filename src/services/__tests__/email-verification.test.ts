import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "crypto";
import { resolveMx } from "dns/promises";
import { prisma } from "@/lib/prisma";
import { createUser, cleanup, uniq } from "@/test/fixtures";
import * as authService from "@/services/auth.service";
import { ConflictError, UnauthorizedError } from "@/utils/errors";

// DNS coz.mlemesi bu ortamda (sandbox/CI/kapali ag) belirsiz sekilde
// yavas/asilan olabiliyor - gercek ag'a bagimli olmayan, deterministik bir
// test icin dns/promises mock'lanir. Varsayilan olarak gecerli bir MX kaydi
// doner (digger testlerdeki @gmail.com adresleri bundan etkilenmez), sadece
// "domain yok" testi ENOTFOUND'a ceviriyor.
vi.mock("dns/promises", () => ({
  resolveMx: vi.fn().mockResolvedValue([{ exchange: "mx.example.com", priority: 10 }]),
}));

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

describe("auth.service - email dogrulama", () => {
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ userIds });
    userIds.length = 0;
  });

  // Resend'in sandbox domaini (onboarding@resend.dev) sadece hesap sahibinin
  // kendi dogrulanmis adresine gonderim yapabiliyordu - gercek kullanicilar
  // dogrulama mailini hic alamiyor, kayit olduktan sonra sonsuza kadar giris
  // yapamaz hale geliyordu. Bu yuzden register() artik otomatik dogruluyor,
  // mail/token hic uretilmiyor (domain eklenip gercek dogrulama acilana kadar).
  it("register otomatik dogrulanmis bir kullanici olusturur, mail/token uretmez", async () => {
    const email = `${uniq("verify")}@gmail.com`;

    const result = await authService.register({ name: "Test Kullanici", password: "test1234", email });

    expect(result).toEqual({ verificationRequired: false, email });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(user.id);
    expect(user.emailVerifiedAt).not.toBeNull();

    const tokenRecord = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id } });
    expect(tokenRecord).toBeNull();
  });

  it("register sonrasi kullanici hemen login yapabilir (dogrulama beklemez)", async () => {
    const email = `${uniq("instant-login")}@gmail.com`;
    await authService.register({ name: "Test", password: "test1234", email });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(user.id);

    const result = await authService.login({ email, password: "test1234" });
    expect(result.token).toBeTruthy();
  });

  it("var olan email ile tekrar kayidi reddeder", async () => {
    const user = await createUser();
    userIds.push(user.id);

    await expect(
      authService.register({ name: "Baska Isim", password: "test1234", email: user.email }),
    ).rejects.toThrow(ConflictError);
  });

  it("MX kaydi olmayan bir domain'e kaydi reddeder", async () => {
    vi.mocked(resolveMx).mockRejectedValueOnce(
      Object.assign(new Error("queryMx ENOTFOUND"), { code: "ENOTFOUND" }),
    );

    await expect(
      authService.register({
        name: "Test",
        password: "test1234",
        email: `${uniq("nodomain")}@bu-domain-kesinlikle-yok-asdqwe123.zzz`,
      }),
    ).rejects.toThrow();
  });

  // register() artik kimseyi dogrulanmamis birakmiyor, ama login()'deki
  // savunma kontrolu hala kodda duruyor (domain eklenip dogrulama tekrar
  // acilirsa diye). Bu durumu register()'i bypass edip elle kuruyoruz.
  it("elle olusturulmus dogrulanmamis bir kullanici login'de EMAIL_NOT_VERIFIED ile reddedilir", async () => {
    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.hash("test1234", 4);
    const email = `${uniq("unverified")}@gmail.com`;

    const user = await prisma.user.create({
      data: { name: "Test", email, passwordHash, emailVerifiedAt: null },
    });
    userIds.push(user.id);

    await expect(authService.login({ email, password: "test1234" })).rejects.toMatchObject({
      statusCode: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
  });

  it("token ile dogrulanan (elle olusturulmus dogrulanmamis) kullanici artik login yapabilir", async () => {
    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.hash("test1234", 4);
    const email = `${uniq("toverify")}@gmail.com`;

    const user = await prisma.user.create({
      data: { name: "Test", email, passwordHash, emailVerifiedAt: null },
    });
    userIds.push(user.id);

    const rawToken = "test-raw-token-" + crypto.randomBytes(8).toString("hex");
    const stored = await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await authService.verifyEmail({ token: rawToken });

    const verifiedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verifiedUser.emailVerifiedAt).not.toBeNull();

    const result = await authService.login({ email, password: "test1234" });
    expect(result.token).toBeTruthy();

    const usedToken = await prisma.emailVerificationToken.findUnique({ where: { id: stored.id } });
    expect(usedToken!.usedAt).not.toBeNull();
  });

  it("gecersiz token'i reddeder", async () => {
    await expect(authService.verifyEmail({ token: "olmayan-token" })).rejects.toThrow(UnauthorizedError);
  });

  it("suresi dolmus token'i reddeder", async () => {
    const user = await createUser();
    userIds.push(user.id);

    const rawToken = "expired-token-" + crypto.randomBytes(8).toString("hex");
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await expect(authService.verifyEmail({ token: rawToken })).rejects.toThrow(UnauthorizedError);
  });

  it("resendVerification var olmayan email icin sessizce basarili doner", async () => {
    await expect(
      authService.resendVerification({ email: "hic-yok@example.com" }),
    ).resolves.toBeUndefined();
  });

  it("resendVerification zaten dogrulanmis kullanici icin yeni token uretmez", async () => {
    const user = await createUser(); // fixture varsayilan olarak dogrulanmis
    userIds.push(user.id);

    await authService.resendVerification({ email: user.email });

    const tokens = await prisma.emailVerificationToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(0);
  });

  it("oauthLogin ile giren kullanici otomatik dogrulanir", async () => {
    const email = `${uniq("oauth")}@gmail.com`;
    const result = await authService.oauthLogin(email, "OAuth Kullanici");
    expect(result.token).toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(user.id);
    expect(user.emailVerifiedAt).not.toBeNull();
  });
});
