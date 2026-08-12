-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "sourceCardId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dailyDigestEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "AutomationRule_sourceCardId_idx" ON "AutomationRule"("sourceCardId");

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_sourceCardId_fkey" FOREIGN KEY ("sourceCardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;
