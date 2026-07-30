-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'WATCHED_CARD_ACTIVITY';

-- CreateTable
CREATE TABLE "CardWatcher" (
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardWatcher_pkey" PRIMARY KEY ("cardId","userId")
);

-- AddForeignKey
ALTER TABLE "CardWatcher" ADD CONSTRAINT "CardWatcher_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardWatcher" ADD CONSTRAINT "CardWatcher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
