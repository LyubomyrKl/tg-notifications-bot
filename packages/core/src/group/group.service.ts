import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  GroupView,
  SubscriberView,
} from '@paedavic/contracts';
import {
  type Group,
  Prisma,
  PrismaService,
  SubscriberStatus,
} from '@paedavic/database';
import { SubscriberService } from '../subscriber/subscriber.service';

const ALL_GROUP_NAME = 'All';

/**
 * Subscriber segments. Every method is sourceId-scoped (tenant isolation). The
 * implicit "All" group always exists, has dynamic membership (every active
 * subscriber, no rows), and cannot be renamed, deleted, or edited member-wise.
 */
@Injectable()
export class GroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscribers: SubscriberService,
  ) {}

  /** Find-or-create the implicit All group (covers pre-existing workspaces). */
  async ensureAll(sourceId: string): Promise<Group> {
    const existing = await this.prisma.group.findFirst({
      where: { sourceId, isAll: true },
    });
    if (existing) return existing;
    return this.prisma.group.create({
      data: { sourceId, name: ALL_GROUP_NAME, isAll: true },
    });
  }

  async create(sourceId: string, name: string): Promise<GroupView> {
    if (name.trim().toLowerCase() === ALL_GROUP_NAME.toLowerCase()) {
      throw new ConflictException('"All" is a reserved group name');
    }
    try {
      const group = await this.prisma.group.create({
        data: { sourceId, name: name.trim() },
      });
      return this.toView(group, 0);
    } catch (err) {
      throw this.mapUniqueError(err);
    }
  }

  async rename(
    sourceId: string,
    id: string,
    name: string,
  ): Promise<GroupView> {
    const group = await this.findOwned(sourceId, id);
    this.assertMutable(group);
    try {
      const updated = await this.prisma.group.update({
        where: { id },
        data: { name: name.trim() },
      });
      return this.toView(updated, await this.memberCount(updated));
    } catch (err) {
      throw this.mapUniqueError(err);
    }
  }

  async delete(sourceId: string, id: string): Promise<void> {
    const group = await this.findOwned(sourceId, id);
    this.assertMutable(group);
    await this.prisma.group.delete({ where: { id } });
  }

  async list(sourceId: string): Promise<GroupView[]> {
    await this.ensureAll(sourceId);
    const groups = await this.prisma.group.findMany({
      where: { sourceId },
      orderBy: [{ isAll: 'desc' }, { createdAt: 'asc' }],
    });
    return Promise.all(
      groups.map(async (g) => this.toView(g, await this.memberCount(g))),
    );
  }

  /** Add subscribers to a named group. Idempotent; foreign subscribers rejected. */
  async addMembers(
    sourceId: string,
    groupId: string,
    subscriberIds: string[],
  ): Promise<GroupView> {
    const group = await this.findOwned(sourceId, groupId);
    this.assertMutable(group, 'add members to');

    // All ids must belong to THIS source AND be active — never segment across
    // tenants, and never add an unsubscribed (consent-exited) person back into a
    // group where they'd inflate counts and sit flagged for deletion.
    const owned = await this.prisma.subscriber.count({
      where: {
        sourceId,
        id: { in: subscriberIds },
        status: SubscriberStatus.active,
      },
    });
    if (owned !== new Set(subscriberIds).size) {
      throw new NotFoundException('One or more subscribers not found or inactive');
    }

    await this.prisma.groupMember.createMany({
      data: subscriberIds.map((subscriberId) => ({ groupId, subscriberId })),
      skipDuplicates: true, // re-adding is a no-op
    });
    return this.toView(group, await this.memberCount(group));
  }

  async removeMember(
    sourceId: string,
    groupId: string,
    subscriberId: string,
  ): Promise<GroupView> {
    const group = await this.findOwned(sourceId, groupId);
    this.assertMutable(group, 'remove members from');
    await this.prisma.groupMember.deleteMany({
      where: { groupId, subscriberId },
    });
    return this.toView(group, await this.memberCount(group));
  }

  /**
   * Reassign a subscriber to `toGroupId`: remove them from every other (non-All)
   * group in this Source and add them to the target. A clean "move" — after this
   * the subscriber's only named group is the target. Tenant-scoped + atomic.
   */
  async moveMember(
    sourceId: string,
    subscriberId: string,
    toGroupId: string,
  ): Promise<GroupView> {
    const target = await this.findOwned(sourceId, toGroupId);
    this.assertMutable(target, 'move members into');
    const subscriber = await this.prisma.subscriber.findFirst({
      where: { id: subscriberId, sourceId, status: SubscriberStatus.active },
    });
    if (!subscriber) {
      throw new NotFoundException('Subscriber not found or inactive');
    }

    await this.prisma.$transaction([
      // Drop from all named groups in this Source (target included — re-added next).
      this.prisma.groupMember.deleteMany({
        where: { subscriberId, group: { sourceId, isAll: false } },
      }),
      this.prisma.groupMember.create({
        data: { groupId: toGroupId, subscriberId },
      }),
    ]);
    return this.toView(target, await this.memberCount(target));
  }

  async members(sourceId: string, groupId: string): Promise<SubscriberView[]> {
    const group = await this.findOwned(sourceId, groupId);
    if (group.isAll) {
      return this.subscribers.list(sourceId); // dynamic = all active
    }
    const rows = await this.prisma.groupMember.findMany({
      where: { groupId, subscriber: { status: SubscriberStatus.active } },
      include: { subscriber: true },
    });
    return rows.map((m) => this.subscribers.toView(m.subscriber));
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async findOwned(sourceId: string, id: string): Promise<Group> {
    const group = await this.prisma.group.findFirst({
      where: { id, sourceId },
    });
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  private assertMutable(group: Group, verb = 'modify'): void {
    if (group.isAll) {
      throw new BadRequestException(
        `The implicit "All" group cannot be ${verb === 'modify' ? 'modified' : verb} (its members are every active subscriber).`,
      );
    }
  }

  /**
   * Member count: active subscribers only, so it matches what {@link members}
   * lists and what a broadcast actually reaches. For All that's every active
   * subscriber; for a named group, members whose subscriber is still active
   * (an unsubscribe shouldn't leave a phantom in the count).
   */
  private memberCount(group: Group): Promise<number> {
    return group.isAll
      ? this.prisma.subscriber.count({
          where: { sourceId: group.sourceId, status: SubscriberStatus.active },
        })
      : this.prisma.groupMember.count({
          where: {
            groupId: group.id,
            subscriber: { status: SubscriberStatus.active },
          },
        });
  }

  private toView(group: Group, memberCount: number): GroupView {
    return {
      id: group.id,
      name: group.name,
      isAll: group.isAll,
      memberCount,
      createdAt: group.createdAt.toISOString(),
    };
  }

  private mapUniqueError(err: unknown): Error {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException('A group with that name already exists');
    }
    return err as Error;
  }
}
