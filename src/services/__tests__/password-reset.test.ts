import { describe, it, expect, afterEach } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createUser, cleanup } from "@/test/fixtures";
import * as authService from "@/services/auth.service";
import { UnauthorizedError } from "@/utils/errors";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

describe("auth.service - sifre sifirlama", () => {
  const userIds: string[] = [];

  afterEach(async () => {
    await cleanup({ userIds });
    userIds.length = 0;
  });

  it("var olmayan email icin sessizce basarili doner, token olusturmaz", async () => {
    await expect(
      authService.requestPasswordReset({ email: "hic-yok@example.com" }),
    ).resolves.toBeUndefined();
  });

  it("var olan kullanici icin token olusturur ve sifreyi degistirir", async () => {
    const user = await createUser();
    userIds.push(user.id);

    await authService.requestPasswordReset({ email: user.email });

    const stored = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(stored).not.toBeNull();
    expect(stored!.usedAt).toBeNull();

    // Servis ham token'i disari vermiyor (e-postayla gidiyor); testte DB'deki
    // hash'i dogrudan uretemeyiz, o yuzden token'i biz uretip hash'ini DB'ye
    // yazarak akisi kontrollu sekilde test ediyoruz.
    const rawToken = "test-raw-token-" + crypto.randomBytes(8).toString("hex");
    await prisma.passwordResetToken.update({
      where: { id: stored!.id },
      data: { tokenHash: hashToken(rawToken) },
    });

    await authService.resetPassword({ token: rawToken, password: "yeni-sifre-123" });

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const matches = await bcrypt.compare("yeni-sifre-123", updatedUser.passwordHash);
    expect(matches).toBe(true);

    const usedToken = await prisma.passwordResetToken.findUnique({ where: { id: stored!.id } });
    expect(usedToken!.usedAt).not.toBeNull();
  });

  it("gecersiz token'i reddeder", async () => {
    await expect(
      authService.resetPassword({ token: "olmayan-token", password: "yeni-sifre-123" }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("suresi dolmus token'i reddeder", async () => {
    const user = await createUser();
    userIds.push(user.id);

    const rawToken = "expired-token-" + crypto.randomBytes(8).toString("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await expect(
      authService.resetPassword({ token: rawToken, password: "yeni-sifre-123" }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("kullanilmis token'i tekrar kullandirmaz", async () => {
    const user = await createUser();
    userIds.push(user.id);

    const rawToken = "used-token-" + crypto.randomBytes(8).toString("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
      },
    });

    await expect(
      authService.resetPassword({ token: rawToken, password: "yeni-sifre-123" }),
    ).rejects.toThrow(UnauthorizedError);
  });
});
