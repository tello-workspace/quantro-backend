import { z } from "zod";

// GitHub'in kendi kurallari: kullanici/organizasyon adi en fazla 39 karakter,
// harf/rakam ve tek tire; depo adi 100 karaktere kadar harf/rakam/nokta/tire/
// alt cizgi. Serbest string kabul edip URL'e gomsek "../" gibi bir deger
// istegi baska bir uca yonlendirebilirdi (quantro-mcp'de ayni sinifi
// kapatmistik) - burada URL uretimi yalnizca gosterim amacli olsa da ayni
// daralmayi bastan yapiyoruz.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

const kolonId = z.string().cuid().nullable().optional();

export const createGithubLinkSchema = z.object({
  owner: z.string().trim().regex(OWNER, "Geçersiz GitHub kullanıcı/organizasyon adı"),
  repo: z.string().trim().regex(REPO, "Geçersiz depo adı"),
  // Kolon eslemesi olusturulurken bos birakilabilir: kullanici once baglantiyi
  // kurup webhook'u GitHub'a yapistirir, eslemeyi sonra yapar.
  branchColumnId: kolonId,
  prOpenColumnId: kolonId,
  prMergedColumnId: kolonId,
});

export const updateGithubLinkSchema = z.object({
  owner: z.string().trim().regex(OWNER, "Geçersiz GitHub kullanıcı/organizasyon adı").optional(),
  repo: z.string().trim().regex(REPO, "Geçersiz depo adı").optional(),
  branchColumnId: kolonId,
  prOpenColumnId: kolonId,
  prMergedColumnId: kolonId,
  isActive: z.boolean().optional(),
});

export type CreateGithubLinkInput = z.infer<typeof createGithubLinkSchema>;
export type UpdateGithubLinkInput = z.infer<typeof updateGithubLinkSchema>;
