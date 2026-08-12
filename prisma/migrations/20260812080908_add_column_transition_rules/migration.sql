-- CreateEnum
CREATE TYPE "ColumnRuleMode" AS ENUM ('OFF', 'WARN', 'ENFORCE');

-- AlterTable
ALTER TABLE "Column" ADD COLUMN     "requireAssignee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireChecklistComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireDescription" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireNoOpenBlockers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transitionMode" "ColumnRuleMode" NOT NULL DEFAULT 'OFF';
