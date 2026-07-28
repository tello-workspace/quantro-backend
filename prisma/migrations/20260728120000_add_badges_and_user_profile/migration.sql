-- Rozet (Badge/UserBadge) ve kullanici profil alanlari.
--
-- NOT: Bu iki degisiklik uzak veritabanina daha once elle uygulanmisti
-- (migration gecmisi o donemde takip edilmiyordu). Bu dosya, gecmisi
-- gercek sema ile hizalamak icin sonradan yazildi; mevcut veritabaninda
-- "uygulanmis" olarak isaretlenir, sifirdan kurulan veritabanlarinda ise
-- normal sekilde calisir.

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("userId","badgeId")
);

-- CreateIndex
CREATE INDEX "Badge_organizationId_idx" ON "Badge"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_organizationId_name_key" ON "Badge"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "Badge" ADD CONSTRAINT "Badge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: kullanici profil alanlari
ALTER TABLE "User" ADD COLUMN     "title" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "experience" TEXT,
ADD COLUMN     "githubUrl" TEXT,
ADD COLUMN     "linkedinUrl" TEXT,
ADD COLUMN     "expertiseAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[];
