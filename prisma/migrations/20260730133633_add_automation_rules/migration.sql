-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('CARD_MOVED_TO_COLUMN', 'CARD_CREATED');

-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('ADD_LABEL', 'MOVE_TO_COLUMN', 'ASSIGN_USER', 'SEND_NOTIFICATION');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'AUTOMATION';

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "AutomationTrigger" NOT NULL,
    "triggerColumnId" TEXT,
    "actionType" "AutomationActionType" NOT NULL,
    "actionLabelId" TEXT,
    "actionColumnId" TEXT,
    "actionUserId" TEXT,
    "actionMessage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationRule_projectId_trigger_idx" ON "AutomationRule"("projectId", "trigger");

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
