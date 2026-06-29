-- CreateEnum
CREATE TYPE "SubscriberStatus" AS ENUM ('active', 'unsubscribed');

-- CreateTable
CREATE TABLE "subscribers" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "username" TEXT,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'active',
    "unsubscribedAt" TIMESTAMP(3),
    "pendingDelete" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isAll" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "groupId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("groupId","subscriberId")
);

-- CreateIndex
CREATE INDEX "subscribers_sourceId_idx" ON "subscribers"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "subscribers_sourceId_telegramUserId_key" ON "subscribers"("sourceId", "telegramUserId");

-- CreateIndex
CREATE INDEX "groups_sourceId_idx" ON "groups"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "groups_sourceId_name_key" ON "groups"("sourceId", "name");

-- CreateIndex
CREATE INDEX "group_members_subscriberId_idx" ON "group_members"("subscriberId");

-- AddForeignKey
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
