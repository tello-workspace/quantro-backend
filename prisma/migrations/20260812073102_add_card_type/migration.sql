-- CreateEnum
CREATE TYPE "CardType" AS ENUM ('EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK');

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "type" "CardType" NOT NULL DEFAULT 'TASK';
