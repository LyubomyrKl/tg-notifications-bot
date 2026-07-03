-- CreateEnum
CREATE TYPE "ScheduledStatus" AS ENUM ('scheduled', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "scheduled_broadcasts" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "groupIds" TEXT[],
    "placeholderValues" JSONB NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "repeat" TEXT NOT NULL DEFAULT 'none',
    "status" "ScheduledStatus" NOT NULL DEFAULT 'scheduled',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_broadcasts_sourceId_idx" ON "scheduled_broadcasts"("sourceId");

-- AddForeignKey
ALTER TABLE "scheduled_broadcasts" ADD CONSTRAINT "scheduled_broadcasts_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_broadcasts" ADD CONSTRAINT "scheduled_broadcasts_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
