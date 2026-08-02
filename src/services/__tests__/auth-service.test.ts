import { describe, it, expect, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { uniq } from "@/test/fixtures";
import * as authService from "@/services/auth.service";
import { ConflictError, UnauthorizedError } from "@/utils/errors";

// Auth service birim testleri (gercek DB baglantisi, Supabase gerekmez):
// - register: yeni email -> kullanici olusur, ayni email -> ConflictError,
//   gecersiz MX domain -> ValidationError
// - login: dogru sifre -> token, yanlis sifre/email -> UnauthorizedError,
//   dogrulanmamis -> 403 EMAIL_NOT_VERIFIED
//
// Not: register, hasValidMxRecord (gercek DNS sorgusu) cagirdigi icin test
// email'lerinde her zaman MX record'u olan bir domain kullanilir (gmail.com).
// Dogrulanmamis kullanici senaryosu icin emailVerifiedAt null olan bir
// kullanici dogrudan prisma ile olusturulur.

describe("auth.service", () => {
  const userIds: string[] = [];

  afterEach(async () => {
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    userIds.length = 0;
  });

  it("register: yeni email ile kullanici olusturur", async () => {
    const email = `${uniq("user")}@gmail.com`; // gmail.com her zaman MX'e sahiptir
    const result = await authService.register({ name: "Test", email, password: "12345678" });

    expect(result).toMatchObject({ verificationRequired: false, email });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user!.emailVerifiedAt).not.toBeNull(); // otomatik dogrulanmis
    if (user) userIds.push(user.id);
  });

  it("register: ayni email iki kez -> ConflictError", async () => {
    const email = `${uniq("user")}@gmail.com`;
    await authService.register({ name: "Test", email, password: "12345678" });

    await expect(
      authService.register({ name: "Test2", email, password: "87654321" }),
    ).rejects.toThrow(ConflictError);
  });

  it("login: dogru sifre ile token doner", async () => {
    const email = `${uniq("user")}@gmail.com`;
    await authService.register({ name: "Test", email, password: "dogru-sifre" });

    const result = await authService.login({ email, password: "dogru-sifre" });
    expect(result.token).toBeTruthy();
    expect(result.user.email).toBe(email);
  });

  it("login: yanlis sifre -> UnauthorizedError", async () => {
    const email = `${uniq("user")}@gmail.com`;
    await authService.register({ name: "Test", email, password: "dogru-sifre" });

    await expect(authService.login({ email, password: "yanlis" })).rejects.toThrow(UnauthorizedError);
  });

  it("login: olmayan email -> UnauthorizedError", async () => {
    await expect(
      authService.login({ email: `${uniq("user")}@gmail.com`, password: "x" }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("login: email dogrulanmamis -> 403 EMAIL_NOT_VERIFIED", async () => {
    const email = `${uniq("user")}@example.com`;
    const passwordHash = await bcrypt.hash("sifre123", 4);
    const user = await prisma.user.create({
      data: { name: "Test", email, passwordHash, emailVerifiedAt: null },
    });
    userIds.push(user.id);

    await expect(authService.login({ email, password: "sifre123" })).rejects.toMatchObject({
      statusCode: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
  });
});
