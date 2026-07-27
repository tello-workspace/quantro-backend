-- CreateEnum
CREATE TYPE "ChangeRequestType" AS ENUM ('CARD_CREATE', 'CARD_UPDATE', 'CARD_DELETE', 'COLUMN_CREATE', 'PROJECT_CREATE');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum: yeni bildirim tipleri
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REQUEST_CREATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REQUEST_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REQUEST_REJECTED';

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" "ChangeRequestType" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "targetCardId" TEXT,
    "targetColumnId" TEXT,
    "requestedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeRequest_organizationId_status_idx" ON "ChangeRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ChangeRequest_requestedById_status_idx" ON "ChangeRequest"("requestedById", "status");

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_targetCardId_fkey" FOREIGN KEY ("targetCardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;
