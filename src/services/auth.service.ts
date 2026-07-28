import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/utils/jwt";
import { ConflictError, UnauthorizedError } from "@/utils/errors";
import { sendPasswordResetEmail } from "@/utils/email";
import type {
  RegisterInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from "@/schemas/auth.schema";

const SALT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 saat

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export type AuthResult = {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });

  if (existing) {
    throw new ConflictError("Bu email adresi zaten kayıtlı");
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
    },
  });

  const token = signToken({ userId: user.id, email: user.email });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
  };
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user) {
    throw new UnauthorizedError("Email veya şifre hatalı");
  }

  const isValid = await bcrypt.compare(input.password, user.passwordHash);

  if (!isValid) {
    throw new UnauthorizedError("Email veya şifre hatalı");
  }

  const token = signToken({ userId: user.id, email: user.email });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
  };
}

// Google/Apple gibi OAuth saglayicilarindan dogrulanmis email+isim ile giris.
// Kullanici yoksa olusturulur (rastgele, bilinmeyen bir parola hash'iyle -
// bu hesapla normal email/sifre login'i asla basarili olmaz).
export async function oauthLogin(email: string, name: string): Promise<AuthResult> {
  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, SALT_ROUNDS);

    user = await prisma.user.create({
      data: { name, email, passwordHash },
    });
  }

  const token = signToken({ userId: user.id, email: user.email });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
  };
}

// Kullanicinin var olup olmadigini disariya sizdirmamak icin her zaman ayni
// (basarili) yaniti donuyoruz; e-posta yalnizca kullanici gercekten varsa
// gonderiliyor.
export async function requestPasswordReset(input: ForgotPasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) return;

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  const frontendUrl = process.env.FRONTEND_URL?.split(",")[0]?.trim() || "http://localhost:3000";
  const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

  await sendPasswordResetEmail(user.email, resetUrl);
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const tokenHash = hashToken(input.token);

  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw new UnauthorizedError("Token geçersiz veya süresi dolmuş");
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    }),
    // Bu token'i kullanildi olarak isaretle, kullanicinin diger tum bekleyen
    // linklerini de gecersiz kil (biri sizmis olabilir).
    prisma.passwordResetToken.updateMany({
      where: { userId: resetToken.userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);
}

const PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  title: true,
  bio: true,
  experience: true,
  githubUrl: true,
  linkedinUrl: true,
  expertiseAreas: true,
  languages: true,
} as const;

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PROFILE_SELECT,
  });

  if (!user) {
    throw new UnauthorizedError("Kullanıcı bulunamadı");
  }

  return user;
}

export async function updateProfile(userId: string, input: UpdateProfileInput) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.bio !== undefined && { bio: input.bio }),
      ...(input.experience !== undefined && { experience: input.experience }),
      ...(input.githubUrl !== undefined && { githubUrl: input.githubUrl }),
      ...(input.linkedinUrl !== undefined && { linkedinUrl: input.linkedinUrl }),
      ...(input.expertiseAreas !== undefined && { expertiseAreas: input.expertiseAreas }),
      ...(input.languages !== undefined && { languages: input.languages }),
    },
    select: PROFILE_SELECT,
  });

  return user;
}
