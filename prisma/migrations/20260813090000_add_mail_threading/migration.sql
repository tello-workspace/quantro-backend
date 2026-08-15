-- AlterTable
ALTER TABLE "Mail" ADD COLUMN     "parentMailId" TEXT,
ADD COLUMN     "threadId" TEXT;

-- Mevcut mesajlar kendi konusmalarinin kokudur: threadId = kendi id'si.
UPDATE "Mail" SET "threadId" = "id" WHERE "threadId" IS NULL;

-- CreateIndex
CREATE INDEX "Mail_threadId_createdAt_idx" ON "Mail"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "Mail_parentMailId_idx" ON "Mail"("parentMailId");

-- AddForeignKey
ALTER TABLE "Mail" ADD CONSTRAINT "Mail_parentMailId_fkey" FOREIGN KEY ("parentMailId") REFERENCES "Mail"("id") ON DELETE SET NULL ON UPDATE CASCADE;
