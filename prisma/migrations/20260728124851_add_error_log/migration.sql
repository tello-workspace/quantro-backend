-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 500,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");
