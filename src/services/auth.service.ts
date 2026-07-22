import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/utils/jwt";
import { ConflictError, UnauthorizedError } from "@/utils/errors";
import type { RegisterInput, LoginInput } from "@/schemas/auth.schema";

const SALT_ROUNDS = 10;

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

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, createdAt: true },
  });

  if (!user) {
    throw new UnauthorizedError("Kullanıcı bulunamadı");
  }

  return user;
}
