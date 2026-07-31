import { z } from "zod";

export const registerSchema = z.object({
  name: z
    .string()
    .min(1, "İsim gerekli")
    .max(100, "İsim en fazla 100 karakter olabilir"),
  email: z
    .string()
    .email("Geçerli bir email adresi girin"),
  password: z
    .string()
    .min(6, "Şifre en az 6 karakter olmalı"),
});

export const loginSchema = z.object({
  email: z
    .string()
    .email("Geçerli bir email adresi girin"),
  password: z
    .string()
    .min(1, "Şifre gerekli"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Geçerli bir email adresi girin"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token gerekli"),
  password: z.string().min(6, "Şifre en az 6 karakter olmalı"),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, "Token gerekli"),
});

export const resendVerificationSchema = z.object({
  email: z.string().email("Geçerli bir email adresi girin"),
});

export const updateProfileSchema = z.object({
  title: z.string().max(100).optional().nullable(),
  bio: z.string().max(1000).optional().nullable(),
  experience: z.string().max(50).optional().nullable(),
  githubUrl: z.string().url("Geçerli bir URL girin").max(200).optional().nullable(),
  linkedinUrl: z.string().url("Geçerli bir URL girin").max(200).optional().nullable(),
  expertiseAreas: z.array(z.string().min(1).max(50)).max(20).optional(),
  languages: z.array(z.string().min(1).max(50)).max(20).optional(),
  language: z.string().max(10).optional().nullable(),
  aiProvider: z.string().max(50).optional().nullable(),
  aiApiKey: z.string().max(500).optional().nullable(),
  aiBaseUrl: z.string().max(500).optional().nullable(),
  aiModel: z.string().max(100).optional().nullable(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
