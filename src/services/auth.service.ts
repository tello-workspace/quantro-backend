import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/utils/jwt";
import { AppError, ConflictError, UnauthorizedError, ValidationError } from "@/utils/errors";
import { sendPasswordResetEmail, sendVerificationEmail, hasValidMxRecord } from "@/utils/email";
import { encryptSecret } from "@/utils/crypto";
import type {
  RegisterInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  VerifyEmailInput,
  ResendVerificationInput,
  UpdateProfileInput,
} from "@/schemas/auth.schema";

const SALT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 saat
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 saat - onboarding akisi, reset'ten daha uzun

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getFrontendUrl(): string {
  return process.env.FRONTEND_URL?.split(",")[0]?.trim() || "http://localhost:3000";
}

async function issueVerificationEmail(userId: string, email: string): Promise<void> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
    },
  });

  const verifyUrl = `${getFrontendUrl()}/verify-email?token=${rawToken}`;
  await sendVerificationEmail(email, verifyUrl);
}

export type AuthResult = {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export type RegisterResult = {
  verificationRequired: boolean;
  email: string;
};

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });

  if (existing) {
    throw new ConflictError("Bu email adresi zaten kayıtlı");
  }

  const domainValid = await hasValidMxRecord(input.email);
  if (!domainValid) {
    throw new ValidationError("Bu email adresine ulaşılamıyor, geçerli bir email adresi girin");
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      emailVerifiedAt: new Date(), // Otomatik doğrulanmış
    },
  });

  // Email doğrulama maili gönderilmez - kullanıcı anında doğrulanmış sayılır
  // await issueVerificationEmail(user.id, user.email); // İptal edildi

  return { verificationRequired: false, email: user.email };
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

  if (!user.emailVerifiedAt) {
    throw new AppError(403, "Email adresiniz henüz doğrulanmadı. Lütfen gelen kutunuzu kontrol edin.", "EMAIL_NOT_VERIFIED");
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

    // OAuth saglayicisi email'i zaten dogruladigi icin dogrudan verified.
    user = await prisma.user.create({
      data: { name, email, passwordHash, emailVerifiedAt: new Date() },
    });
  } else if (!user.emailVerifiedAt) {
    // Daha once normal kayitla dogrulanmadan birakilmis bir hesap Google ile
    // giris yapiyorsa, artik dogrulandigi icin arada sikismasin.
    user = await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
  }

  const token = signToken({ userId: user.id, email: user.email });

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
  };
}

// Token'i dogrular, kullaniciyi verified isaretler ve TUM bekleyen dogrulama
// linklerini kullanildi olarak isaretler (biri sizmis olabilir - reset akisiyla ayni mantik).
export async function verifyEmail(input: VerifyEmailInput): Promise<void> {
  const tokenHash = hashToken(input.token);

  const verificationToken = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
  });

  if (!verificationToken || verificationToken.usedAt || verificationToken.expiresAt < new Date()) {
    throw new UnauthorizedError("Token geçersiz veya süresi dolmuş");
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: verificationToken.userId },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.emailVerificationToken.updateMany({
      where: { userId: verificationToken.userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);
}

// Kullanicinin var olup olmadigini veya zaten dogrulanmis oldugunu disariya
// sizdirmamak icin her zaman ayni (basarili) yaniti dondurur - reset akisiyla ayni desen.
export async function resendVerification(input: ResendVerificationInput): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || user.emailVerifiedAt) return;

  await issueVerificationEmail(user.id, user.email);
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
  avatarUrl: true,
  title: true,
  bio: true,
  experience: true,
  githubUrl: true,
  linkedinUrl: true,
  expertiseAreas: true,
  languages: true,
  language: true,
  aiProvider: true,
  aiApiKey: true, // sadece varlik kontrolu icin secilir, cevapta hicbir zaman geri donmez
  aiBaseUrl: true,
  aiModel: true,
} as const;

// aiApiKey sifreli tutulur (bkz. utils/crypto.ts) ve API'den asla geri
// donmez - sadece kayitli olup olmadigi (hasAiApiKey) bilgisi verilir.
// Boylece paylasilan DB bir sekilde disari sizsa (dump, log vb.) kullanicilarin
// gercek OpenAI/Groq anahtarlari acikta olmaz.
function toProfileResponse<T extends { aiApiKey: string | null }>(user: T) {
  const { aiApiKey, ...rest } = user;
  return { ...rest, hasAiApiKey: aiApiKey !== null };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PROFILE_SELECT,
  });

  if (!user) {
    throw new UnauthorizedError("Kullanıcı bulunamadı");
  }

  return toProfileResponse(user);
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
      ...(input.language !== undefined && { language: input.language || "tr" }),
      ...(input.aiProvider !== undefined && { aiProvider: input.aiProvider }),
      // Bos string/null = "anahtari kaldir", dolu string = sifrelenip saklanir.
      // Frontend "degistirmedim" durumunda bu alani hic gondermiyor (undefined
      // kalir), o yuzden burada dokunulmamis anahtar asla ustune yazilmaz.
      ...(input.aiApiKey !== undefined && {
        aiApiKey: input.aiApiKey ? encryptSecret(input.aiApiKey) : null,
      }),
      ...(input.aiBaseUrl !== undefined && { aiBaseUrl: input.aiBaseUrl }),
      ...(input.aiModel !== undefined && { aiModel: input.aiModel }),
    },
    select: PROFILE_SELECT,
  });

  return toProfileResponse(user);
}
