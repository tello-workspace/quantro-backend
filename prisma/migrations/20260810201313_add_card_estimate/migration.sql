-- CreateEnum
CREATE TYPE "EstimateUnit" AS ENUM ('POINTS', 'HOURS');

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "estimate" INTEGER;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "estimateUnit" "EstimateUnit" NOT NULL DEFAULT 'POINTS';
