import { BadRequestException } from '@nestjs/common';
import { SubscriberService } from '../subscriber/subscriber.service';
import { InviteService } from './invite.service';

/**
 * In-memory Prisma covering the invite open/create flow. `$transaction` simply
 * invokes the callback with the same fake, which is sufficient to exercise the
 * idempotency + attribution logic.
 */
function makeFakePrisma() {
  const links: any[] = [];
  const joins: any[] = [];
  const members: any[] = [];
  const subscribers: any[] = [];
  const sources: any[] = [{ id: 'src_A', name: 'Acme', archivedAt: null }];
  let sseq = 0;

  const self: any = {
    links,
    joins,
    members,
    subscribers,
    inviteLink: {
      findUnique: async ({ where, include }: any) => {
        const l = links.find((x) => x.token === where.token || x.id === where.id);
        if (!l) return null;
        if (include?.group || include?.source) {
          const src = sources.find((s) => s.id === l.sourceId);
          return {
            ...l,
            group: include?.group && l.groupId ? { name: 'VIP' } : null,
            source: include?.source ? { archivedAt: src?.archivedAt ?? null } : undefined,
          };
        }
        return l;
      },
      update: async ({ where, data }: any) => {
        const l = links.find((x) => x.id === where.id)!;
        if (data.joinCount?.increment) l.joinCount += data.joinCount.increment;
        if (data.revokedAt !== undefined) l.revokedAt = data.revokedAt;
        return l;
      },
    },
    inviteJoin: {
      findUnique: async ({ where }: any) =>
        joins.find(
          (j) =>
            j.inviteLinkId === where.inviteLinkId_subscriberId.inviteLinkId &&
            j.subscriberId === where.inviteLinkId_subscriberId.subscriberId,
        ) ?? null,
      create: async ({ data }: any) => {
        joins.push(data);
        return data;
      },
    },
    groupMember: {
      createMany: async ({ data, skipDuplicates }: any) => {
        for (const d of data) {
          const dupe = members.some(
            (m) => m.groupId === d.groupId && m.subscriberId === d.subscriberId,
          );
          if (dupe && skipDuplicates) continue;
          members.push(d);
        }
      },
    },
    subscriber: {
      findFirst: async ({ where }: any) =>
        subscribers.find((s) =>
          Object.entries(where).every(([k, v]: [string, any]) =>
            v && typeof v === 'object' && 'not' in v
              ? s[k] !== v.not
              : s[k] === v,
          ),
        ) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const key = where.sourceId_telegramUserId;
        let s = subscribers.find(
          (x) =>
            x.sourceId === key.sourceId &&
            x.telegramUserId === key.telegramUserId,
        );
        if (s) {
          Object.assign(s, update);
          return s;
        }
        s = {
          id: `sub_${++sseq}`,
          status: 'active',
          username: null,
          ...create,
        };
        subscribers.push(s);
        return s;
      },
      update: async ({ where, data }: any) => {
        const s = subscribers.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
    },
    source: {
      findUnique: async ({ where }: any) =>
        sources.find((s) => s.id === where.id) ?? null,
    },
    $transaction: async (fn: any) => fn(self),
  };
  return self;
}

const telegram = { buildStartLink: (t: string) => `https://t.me/bot?start=${t}` };

function seedLink(fake: any, over: Record<string, unknown> = {}) {
  const link = {
    id: 'lnk_1',
    sourceId: 'src_A',
    token: 'inv_abc',
    groupId: 'g_vip',
    notificationId: null,
    expiresAt: null,
    revokedAt: null,
    joinCount: 0,
    createdAt: new Date(),
    ...over,
  };
  fake.links.push(link);
  return link;
}

describe('InviteService.open', () => {
  it('subscribes, attributes, joins group, and counts — once', async () => {
    const fake = makeFakePrisma();
    seedLink(fake);
    const svc = new InviteService(
      fake,
      telegram as any,
      new SubscriberService(fake, { record: async () => {} } as any),
    );

    const r1 = await svc.open('inv_abc', 777n, { username: 'neo', name: 'Neo A' });
    expect(r1.alreadyJoined).toBe(false);
    expect(r1.sourceName).toBe('Acme');
    expect(r1.groupName).toBe('VIP');
    expect(fake.links[0].joinCount).toBe(1);
    expect(fake.joins).toHaveLength(1);
    expect(fake.members).toHaveLength(1);

    // Reopen — idempotent: no double count, no duplicate join/membership.
    const r2 = await svc.open('inv_abc', 777n, { username: 'neo', name: 'Neo A' });
    expect(r2.alreadyJoined).toBe(true);
    expect(fake.links[0].joinCount).toBe(1);
    expect(fake.joins).toHaveLength(1);
    expect(fake.members).toHaveLength(1);
  });

  it('rejects a revoked link', async () => {
    const fake = makeFakePrisma();
    seedLink(fake, { revokedAt: new Date('2020-01-01') });
    const svc = new InviteService(fake, telegram as any, new SubscriberService(fake, { record: async () => {} } as any));
    await expect(svc.open('inv_abc', 1n, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an expired link', async () => {
    const fake = makeFakePrisma();
    seedLink(fake, { expiresAt: new Date('2020-01-01') });
    const svc = new InviteService(fake, telegram as any, new SubscriberService(fake, { record: async () => {} } as any));
    await expect(
      svc.open('inv_abc', 1n, {}, new Date('2026-01-01')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('re-activates a previously unsubscribed opener (explicit opt-in)', async () => {
    const fake = makeFakePrisma();
    seedLink(fake, { groupId: null });
    fake.subscribers.push({
      id: 'sub_x',
      sourceId: 'src_A',
      telegramUserId: 5n,
      status: 'unsubscribed',
    });
    const svc = new InviteService(fake, telegram as any, new SubscriberService(fake, { record: async () => {} } as any));

    await svc.open('inv_abc', 5n, {});
    expect(fake.subscribers[0].status).toBe('active');
  });

  it('routes invite tokens by prefix', () => {
    expect(InviteService.isInviteToken('inv_xyz')).toBe(true);
    expect(InviteService.isInviteToken('plainStartToken')).toBe(false);
  });
});
