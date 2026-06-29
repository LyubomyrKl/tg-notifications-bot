-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "groupId" TEXT,
    "notificationId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "joinCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_joins" (
    "id" TEXT NOT NULL,
    "inviteLinkId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_joins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_key" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_sourceId_idx" ON "invite_links"("sourceId");

-- CreateIndex
CREATE INDEX "invite_joins_inviteLinkId_idx" ON "invite_joins"("inviteLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "invite_joins_inviteLinkId_subscriberId_key" ON "invite_joins"("inviteLinkId", "subscriberId");

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_joins" ADD CONSTRAINT "invite_joins_inviteLinkId_fkey" FOREIGN KEY ("inviteLinkId") REFERENCES "invite_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_joins" ADD CONSTRAINT "invite_joins_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
