-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "archivedById" TEXT;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
