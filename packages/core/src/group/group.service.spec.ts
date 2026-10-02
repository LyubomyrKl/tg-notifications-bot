import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GroupService } from './group.service';

/**
 * In-memory Prisma covering the group/subscriber/member queries GroupService
 * runs. Enough to prove tenant isolation, All-group protection, and idempotent
 * many-to-many membership without a real database.
 */
function makeFakePrisma() {
  const groups: any[] = [];
  const subscribers: any[] = [];
  const members: any[] = [];
  let gseq = 0;
  const whereMatch = (row: any, where: any) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v)
        return (v as any).in.includes(row[k]);
      return row[k] === v;
    });
  return {
    groups,
    subscribers,
    members,
    group: {
      create: async ({ data }: any) => {
        const g = {
          id: `g_${++gseq}`,
          isAll: false,
          createdAt: new Date(),
          ...data,
        };
        groups.push(g);
        return g;
      },
      findFirst: async ({ where }: any) =>
        groups.find((g) => whereMatch(g, where)) ?? null,
      findMany: async ({ where }: any) =>
        groups.filter((g) => whereMatch(g, where)),
      update: async ({ where, data }: any) => {
        const g = groups.find((x) => x.id === where.id)!;
        Object.assign(g, data);
        return g;
      },
      delete: async ({ where }: any) => {
        const i = groups.findIndex((x) => x.id === where.id);
        return groups.splice(i, 1)[0];
      },
    },
    subscriber: {
      count: async ({ where }: any) =>
        subscribers.filter((s) => whereMatch(s, where)).length,
      findMany: async () => subscribers,
      findFirst: async ({ where }: any) =>
        subscribers.find((s) => whereMatch(s, where)) ?? null,
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
      create: async ({ data }: any) => {
        members.push(data);
        return data;
      },
      deleteMany: async ({ where }: any) => {
        // Support the nested `group: { sourceId, isAll }` filter moveMember uses.
        const groupFilter = where.group;
        const rest = { ...where };
        delete rest.group;
        for (let i = members.length - 1; i >= 0; i--) {
          const m = members[i];
          if (!whereMatch(m, rest)) continue;
          if (groupFilter) {
            const g = groups.find((x) => x.id === m.groupId);
            if (!g || !whereMatch(g, groupFilter)) continue;
          }
          members.splice(i, 1);
        }
      },
      count: async ({ where }: any) => {
        // Support the nested `subscriber: { status }` filter memberCount uses:
        // only count members whose subscriber matches (e.g. still active).
        const subFilter = where.subscriber;
        const rest = { ...where };
        delete rest.subscriber;
        return members.filter((m) => {
          if (!whereMatch(m, rest)) return false;
          if (subFilter) {
            const s = subscribers.find((x) => x.id === m.subscriberId);
            if (!s || !whereMatch(s, subFilter)) return false;
          }
          return true;
        }).length;
      },
      findMany: async () => [],
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
}

const subs = { list: async () => [], toView: (s: any) => s } as any;

describe('GroupService', () => {
  it('blocks renaming/deleting/editing the implicit All group', async () => {
    const fake = makeFakePrisma();
    fake.groups.push({
      id: 'g_all',
      sourceId: 'src_A',
      name: 'All',
      isAll: true,
      createdAt: new Date(),
    });
    const svc = new GroupService(fake as any, subs);

    await expect(svc.rename('src_A', 'g_all', 'X')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.delete('src_A', 'g_all')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.addMembers('src_A', 'g_all', ['s1']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces tenant isolation on group operations', async () => {
    const fake = makeFakePrisma();
    const svc = new GroupService(fake as any, subs);
    const g = await svc.create('src_A', 'VIP');

    await expect(svc.rename('src_B', g.id, 'X')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.delete('src_B', g.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('adds members idempotently and rejects foreign subscribers', async () => {
    const fake = makeFakePrisma();
    fake.subscribers.push(
      { id: 's1', sourceId: 'src_A', status: 'active' },
      { id: 's2', sourceId: 'src_A', status: 'active' },
    );
    const svc = new GroupService(fake as any, subs);
    const g = await svc.create('src_A', 'VIP');

    let view = await svc.addMembers('src_A', g.id, ['s1', 's2']);
    expect(view.memberCount).toBe(2);

    // Re-adding the same subscribers is a no-op (idempotent).
    view = await svc.addMembers('src_A', g.id, ['s1']);
    expect(view.memberCount).toBe(2);

    // A subscriber from another tenant cannot be added.
    await expect(
      svc.addMembers('src_A', g.id, ['s_foreign']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes a member (many-to-many)', async () => {
    const fake = makeFakePrisma();
    fake.subscribers.push({ id: 's1', sourceId: 'src_A', status: 'active' });
    const svc = new GroupService(fake as any, subs);
    const g = await svc.create('src_A', 'VIP');
    await svc.addMembers('src_A', g.id, ['s1']);

    const view = await svc.removeMember('src_A', g.id, 's1');
    expect(view.memberCount).toBe(0);
  });

  it('moves a subscriber to another group (drops them from their others)', async () => {
    const fake = makeFakePrisma();
    fake.subscribers.push({ id: 's1', sourceId: 'src_A', status: 'active' });
    const svc = new GroupService(fake as any, subs);
    const from = await svc.create('src_A', 'Old');
    const to = await svc.create('src_A', 'New');
    await svc.addMembers('src_A', from.id, ['s1']);

    const view = await svc.moveMember('src_A', 's1', to.id);
    expect(view.id).toBe(to.id);
    expect(view.memberCount).toBe(1);
    // Only a member of the target now — the old group is empty.
    expect(fake.members.filter((m) => m.groupId === from.id)).toHaveLength(0);
    expect(fake.members.filter((m) => m.groupId === to.id)).toHaveLength(1);
  });

  it('rejects moving a foreign / unknown subscriber', async () => {
    const fake = makeFakePrisma();
    const svc = new GroupService(fake as any, subs);
    const to = await svc.create('src_A', 'New');
    await expect(
      svc.moveMember('src_A', 's_foreign', to.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cannot move a subscriber into the implicit All group', async () => {
    const fake = makeFakePrisma();
    fake.subscribers.push({ id: 's1', sourceId: 'src_A', status: 'active' });
    fake.groups.push({
      id: 'g_all',
      sourceId: 'src_A',
      name: 'All',
      isAll: true,
      createdAt: new Date(),
    });
    const svc = new GroupService(fake as any, subs);
    await expect(
      svc.moveMember('src_A', 's1', 'g_all'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
