-- Invitation modeli (email bazli, tek atama) OrganizationInvitation'a
-- (davet edilen zaten kayitli bir User olur, rol secilebilir) yeniden
-- tasarlandi; Card.assigneeId (tekli atama) yerine CardAssignee (coklu
-- atama) tablosu eklendi.
--
-- NOT: Bu degisiklik uzak veritabanina daha once elle uygulanmisti
-- (migration gecmisi o donemde takip edilmiyordu). Bu dosya, gecmisi
-- gercek sema ile hizalamak icin sonradan yazildi; mevcut veritabaninda
-- "uygulanmis" olarak isaretlenir, sifirdan kurulan veritabanlarinda ise
-- normal sekilde calisir.

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_invitationId_fkey";

-- DropForeignKey
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_inviterId_fkey";

-- DropForeignKey
ALTER TABLE "Card" DROP CONSTRAINT "Card_assigneeId_fkey";

-- DropIndex
DROP INDEX "Card_assigneeId_idx";

-- AlterTable
ALTER TABLE "Card" DROP COLUMN "assigneeId";

-- DropTable
DROP TABLE "Invitation";

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invitedUserId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationInvitation_invitedUserId_status_idx" ON "OrganizationInvitation"("invitedUserId", "status");

-- CreateTable
CREATE TABLE "CardAssignee" (
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "CardAssignee_pkey" PRIMARY KEY ("cardId","userId")
);

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_invitedUserId_fkey" FOREIGN KEY ("invitedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "OrganizationInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardAssignee" ADD CONSTRAINT "CardAssignee_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardAssignee" ADD CONSTRAINT "CardAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
