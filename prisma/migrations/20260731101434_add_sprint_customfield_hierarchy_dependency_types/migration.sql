-- CreateEnum
CREATE TYPE "SprintStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT', 'CHECKBOX');

-- CreateEnum
CREATE TYPE "DependencyRelationType" AS ENUM ('BLOCKS', 'RELATES_TO', 'DUPLICATES', 'CLONES');

-- AlterEnum
ALTER TYPE "AutomationActionType" ADD VALUE 'CREATE_CARD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AutomationTrigger" ADD VALUE 'SCHEDULED';
ALTER TYPE "AutomationTrigger" ADD VALUE 'CARD_DUE_SOON';

-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "dueSoonDays" INTEGER,
ADD COLUMN     "scheduleDayOfWeek" INTEGER;

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "parentCardId" TEXT,
ADD COLUMN     "sprintId" TEXT;

-- AlterTable
ALTER TABLE "CardDependency" ADD COLUMN     "relationType" "DependencyRelationType" NOT NULL DEFAULT 'BLOCKS';

-- CreateTable
CREATE TABLE "Sprint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "status" "SprintStatus" NOT NULL DEFAULT 'PLANNED',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardCustomFieldValue" (
    "cardId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" TEXT,

    CONSTRAINT "CardCustomFieldValue_pkey" PRIMARY KEY ("cardId","fieldId")
);

-- CreateIndex
CREATE INDEX "Sprint_projectId_status_idx" ON "Sprint"("projectId", "status");

-- CreateIndex
CREATE INDEX "CustomFieldDefinition_projectId_idx" ON "CustomFieldDefinition"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_projectId_name_key" ON "CustomFieldDefinition"("projectId", "name");

-- CreateIndex
CREATE INDEX "Card_sprintId_idx" ON "Card"("sprintId");

-- CreateIndex
CREATE INDEX "Card_parentCardId_idx" ON "Card"("parentCardId");

-- AddForeignKey
ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardCustomFieldValue" ADD CONSTRAINT "CardCustomFieldValue_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardCustomFieldValue" ADD CONSTRAINT "CardCustomFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomFieldDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_parentCardId_fkey" FOREIGN KEY ("parentCardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;
