-- AlterTable
ALTER TABLE "User" ADD COLUMN     "company" TEXT,
ADD COLUMN     "githubSyncedAt" TIMESTAMP(3),
ADD COLUMN     "githubUsername" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "publicRepos" INTEGER;
