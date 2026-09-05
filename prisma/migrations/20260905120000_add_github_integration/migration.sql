-- GitHub entegrasyonu: depo baglantisi, kart<->PR bagi, teslimat tekillestirmesi.
--
-- Bu repoda `prisma migrate deploy` CALISTIRILMIYOR (paylasimli Supabase,
-- migration gecmisi tabloda yok); SQL elle uygulaniyor. Bu yuzden her adim
-- IF NOT EXISTS ile yazildi: yarim uygulanmis bir calistirmadan sonra
-- tekrar calistirmak hata vermesin.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "GithubLinkKind" AS ENUM ('BRANCH', 'PULL_REQUEST');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "GithubRepoLink" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchColumnId" TEXT,
    "prOpenColumnId" TEXT,
    "prMergedColumnId" TEXT,
    "installationId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubRepoLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "GithubCardLink" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "repoLinkId" TEXT NOT NULL,
    "kind" "GithubLinkKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT NOT NULL,
    "state" TEXT,
    "authorLogin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubCardLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "GithubWebhookEvent" (
    "id" TEXT NOT NULL,
    "repoLinkId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- projectId tekil: v1'de bir proje en fazla bir depoya baglanir.
CREATE UNIQUE INDEX IF NOT EXISTS "GithubRepoLink_projectId_key" ON "GithubRepoLink"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GithubRepoLink_owner_repo_idx" ON "GithubRepoLink"("owner", "repo");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GithubCardLink_cardId_idx" ON "GithubCardLink"("cardId");

-- CreateIndex
-- upsert'in anahtari: ayni PR ayni karta iki kez baglanmasin.
CREATE UNIQUE INDEX IF NOT EXISTS "GithubCardLink_repoLinkId_kind_reference_cardId_key" ON "GithubCardLink"("repoLinkId", "kind", "reference", "cardId");

-- CreateIndex
-- Tekillestirmenin kalbi: ayni teslimat ikinci kez islenmemeli.
CREATE UNIQUE INDEX IF NOT EXISTS "GithubWebhookEvent_repoLinkId_deliveryId_key" ON "GithubWebhookEvent"("repoLinkId", "deliveryId");

-- CreateIndex
-- Eski kayitlarin budanmasi icin.
CREATE INDEX IF NOT EXISTS "GithubWebhookEvent_receivedAt_idx" ON "GithubWebhookEvent"("receivedAt");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "GithubRepoLink" ADD CONSTRAINT "GithubRepoLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "GithubRepoLink" ADD CONSTRAINT "GithubRepoLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "GithubCardLink" ADD CONSTRAINT "GithubCardLink_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "GithubCardLink" ADD CONSTRAINT "GithubCardLink_repoLinkId_fkey" FOREIGN KEY ("repoLinkId") REFERENCES "GithubRepoLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "GithubWebhookEvent" ADD CONSTRAINT "GithubWebhookEvent_repoLinkId_fkey" FOREIGN KEY ("repoLinkId") REFERENCES "GithubRepoLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
