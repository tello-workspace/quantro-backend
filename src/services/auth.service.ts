import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/utils/jwt";
import { ConflictError, UnauthorizedError } from "@/utils/errors";
import type { RegisterInput, LoginInput, UpdateProfileInput } from "@/schemas/auth.schema";

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
