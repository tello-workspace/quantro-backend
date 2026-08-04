-- Sprint ozelliginin ve storyPoints alanlarinin kaldirilmasi.
--
-- Bu degisiklikler sema dosyasinda birkac commit once yapilmisti (bkz.
-- b984de8, b08eeab, dc2b791) ama migration uretilmedigi icin veritabani
-- geride kalmisti: sema Sprint'i bilmiyordu, tablo hala duruyordu.
--
-- Uygulanmadan once veri kontrol edildi:
--   Sprint tablosu           -> 1 satir ("wqdfwaw", hedefsiz/tarihsiz test kaydi)
--   sprintId dolu kart       -> 0
--   storyPoints dolu kart    -> 0
--   storyPoints dolu sablon  -> 0
--   WATCHED_CARD_ACTIVITY    -> Notification 0, UserNotificationPref 0 kullanim
-- Yani gercek veri kaybi yok. WATCHED_CARD_ACTIVITY, CardWatcher
-- kaldirilirken enum'da unutulmus bir kalintiydi.

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('ASSIGNED', 'BLOCKER_RESOLVED', 'DEADLINE_RISK', 'STALE_CARD', 'WIP_EXCEEDED', 'ORG_INVITE', 'ORG_JOINED', 'ORG_REMOVED', 'PROJECT_CREATED', 'PROJECT_DELETED', 'ROLE_CHANGED', 'REQUEST_CREATED', 'REQUEST_APPROVED', 'REQUEST_REJECTED', 'MENTIONED', 'AUTOMATION');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TABLE "UserNotificationPref" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "public"."NotificationType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Card" DROP CONSTRAINT "Card_sprintId_fkey";

-- DropForeignKey
ALTER TABLE "Sprint" DROP CONSTRAINT "Sprint_projectId_fkey";

-- DropIndex
DROP INDEX "Card_sprintId_idx";

-- AlterTable
ALTER TABLE "Card" DROP COLUMN "sprintId",
DROP COLUMN "storyPoints";

-- AlterTable
ALTER TABLE "CardTemplate" DROP COLUMN "storyPoints";

-- DropTable
DROP TABLE "Sprint";

-- DropEnum
DROP TYPE "SprintStatus";

