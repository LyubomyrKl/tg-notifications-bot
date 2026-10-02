import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateInviteLinkInput,
  InviteLinkDetail,
  InviteLinkView,
} from '@paedavic/contracts';
import {
  type InviteLink,
  PrismaService,
  SubscriberStatus,
} from '@paedavic/database';
import { TelegramService } from '@paedavic/telegram';
import { generateToken } from '../crypto/crypto.util';
import { SubscriberService } from '../subscriber/subscriber.service';

const TOKEN_PREFIX = 'inv_';

export interface InviteOpenResult {
  sourceId: string;
  sourceName: string;
  groupName: string | null;
  notificationId: string | null;
  /** True when this Telegram user had already joined via this link before. */
  alreadyJoined: boolean;
}

/**
 * Invite links: issue (Source-scoped), open (public subscribe flow), revoke,
 * and attribution. Opening is idempotent — reopening never double-counts or
 * duplicates membership. The `inv_` token prefix lets the bot route /start.
 */
@Injectable()
export class InviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly subscribers: SubscriberService,
  ) {}

  static readonly TOKEN_PREFIX = TOKEN_PREFIX;

  static isInviteToken(token: string): boolean {
    return token.startsWith(this.TOKEN_PREFIX);
  }

  async create(
    sourceId: string,
    input: CreateInviteLinkInput,
  ): Promise<InviteLinkView> {
    // Bindings must belong to THIS source — never point at another tenant's data.
    if (input.groupId) {
      const group = await this.prisma.group.findFirst({
        where: { id: input.groupId, sourceId },
      });
      if (!group) throw new NotFoundException('Group not found');
      if (group.isAll) {
        throw new BadRequestException(
          'Binding to the implicit "All" group is unnecessary — everyone is in it.',
        );
      }
    }
    if (input.notificationId) {
      const notif = await this.prisma.notification.findFirst({
        where: { id: input.notificationId, sourceId, archivedAt: null },
      });
      if (!notif) throw new NotFoundException('Notification not found');
    }

    const link = await this.prisma.inviteLink.create({
      data: {
        sourceId,
        token: TOKEN_PREFIX + generateToken(),
        groupId: input.groupId ?? null,
        notificationId: input.notificationId ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
      include: { group: { select: { name: true } } },
    });
    return this.toView(link);
  }

  async list(sourceId: string): Promise<InviteLinkView[]> {
    const links = await this.prisma.inviteLink.findMany({
      where: { sourceId },
      orderBy: { createdAt: 'desc' },
      include: { group: { select: { name: true } } },
    });
    return links.map((l) => this.toView(l));
  }

  async get(sourceId: string, id: string): Promise<InviteLinkDetail> {
    const link = await this.prisma.inviteLink.findFirst({
      where: { id, sourceId },
      include: {
        group: { select: { name: true } },
        joins: {
          include: { subscriber: true },
          orderBy: { joinedAt: 'desc' },
        },
      },
    });
    if (!link) throw new NotFoundException('Invite link not found');
    return {
      ...this.toView(link),
      joins: link.joins.map((j) => ({
        subscriberId: j.subscriberId,
        telegramUserId: j.subscriber.telegramUserId.toString(),
        username: j.subscriber.username,
        joinedAt: j.joinedAt.toISOString(),
      })),
    };
  }

  async revoke(sourceId: string, id: string): Promise<InviteLinkView> {
    const link = await this.prisma.inviteLink.findFirst({
      where: { id, sourceId },
      include: { group: { select: { name: true } } },
    });
    if (!link) throw new NotFoundException('Invite link not found');
    if (link.revokedAt) return this.toView(link); // idempotent
    const updated = await this.prisma.inviteLink.update({
      where: { id },
      data: { revokedAt: new Date() },
      include: { group: { select: { name: true } } },
    });
    return this.toView(updated);
  }

  /**
   * Open a link (public). Subscribes the opener to the link's Source, records
   * attribution, and adds them to the bound group. Idempotent: reopening
   * re-confirms without double-counting or duplicating membership.
   *
   * `now` is injected so expiry is deterministically testable.
   */
  async open(
    token: string,
    telegramUserId: bigint,
    identity: { username?: string; name?: string },
    now: Date = new Date(),
  ): Promise<InviteOpenResult> {
    const link = await this.prisma.inviteLink.findUnique({
      where: { token },
      include: { group: true, source: { select: { archivedAt: true } } },
    });
    if (!link) throw new NotFoundException('Invalid invite link');
    if (link.revokedAt) throw new BadRequestException('This link was revoked');
    if (link.expiresAt && link.expiresAt <= now) {
      throw new BadRequestException('This link has expired');
    }
    // An archived workspace is dead everywhere else (resolve/link all filter it) —
    // its invite links must not keep subscribing people into a closed workspace.
    if (link.source.archivedAt) {
      throw new BadRequestException('This workspace is no longer active');
    }

    // Subscribe to the LINK's source (re-activating a prior unsubscribe — opening
    // an invite is an explicit opt-in).
    const subscriber = await this.subscribers.upsert(
      link.sourceId,
      telegramUserId,
      identity.username,
      identity.name,
    );
    if (subscriber.status !== SubscriberStatus.active) {
      await this.prisma.subscriber.update({
        where: { id: subscriber.id },
        data: {
          status: SubscriberStatus.active,
          unsubscribedAt: null,
          pendingDelete: false,
        },
      });
    }

    // Attribution + join-count + group membership, atomically and idempotently.
    const alreadyJoined = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.inviteJoin.findUnique({
        where: {
          inviteLinkId_subscriberId: {
            inviteLinkId: link.id,
            subscriberId: subscriber.id,
          },
        },
      });
      if (!existing) {
        await tx.inviteJoin.create({
          data: { inviteLinkId: link.id, subscriberId: subscriber.id },
        });
        await tx.inviteLink.update({
          where: { id: link.id },
          data: { joinCount: { increment: 1 } },
        });
      }
      if (link.groupId) {
        await tx.groupMember.createMany({
          data: [{ groupId: link.groupId, subscriberId: subscriber.id }],
          skipDuplicates: true,
        });
      }
      return existing !== null;
    });

    const source = await this.prisma.source.findUnique({
      where: { id: link.sourceId },
      select: { name: true },
    });

    return {
      sourceId: link.sourceId,
      sourceName: source?.name ?? 'workspace',
      groupName: link.group?.name ?? null,
      notificationId: link.notificationId,
      alreadyJoined,
    };
  }

  private toView(
    link: InviteLink & { group?: { name: string } | null },
  ): InviteLinkView {
    const active = !link.revokedAt && (!link.expiresAt || link.expiresAt > new Date());
    return {
      id: link.id,
      url: this.telegram.buildStartLink(link.token),
      token: link.token,
      groupId: link.groupId,
      groupName: link.group?.name ?? null,
      notificationId: link.notificationId,
      expiresAt: link.expiresAt?.toISOString() ?? null,
      revokedAt: link.revokedAt?.toISOString() ?? null,
      active,
      joinCount: link.joinCount,
      createdAt: link.createdAt.toISOString(),
    };
  }
}
