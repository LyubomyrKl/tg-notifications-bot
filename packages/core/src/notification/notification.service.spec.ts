import { NotFoundException } from '@nestjs/common';
import type { Notification } from '@paedavic/database';
import { NotificationService } from './notification.service';

/** Minimal in-memory Prisma covering the notification queries the service runs. */
function makeFakePrisma() {
  const rows: Notification[] = [];
  let seq = 0;
  const matches = (r: Notification, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'archivedAt') return r.archivedAt === v;
      return (r as Record<string, unknown>)[k] === v;
    });
  return {
    rows,
    notification: {
      create: async ({ data }: any) => {
        const row: Notification = {
          id: `n_${++seq}`,
          name: data.name,
          body: data.body,
          mediaUrl: data.mediaUrl ?? null,
          mediaType: data.mediaType ?? null,
          placeholders: data.placeholders ?? [],
          ephemeral: data.ephemeral ?? false,
          sourceId: data.sourceId,
          archivedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: any) =>
        rows.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: any) =>
        rows.filter((r) => matches(r, where)),
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
    },
  };
}

describe('NotificationService (tenant isolation)', () => {
  it('never lets one Source read/edit/archive another Source\'s template', async () => {
    const fake = makeFakePrisma();
    const svc = new NotificationService(fake as any);

    const mine = await svc.create('src_A', {
      name: 'Launch',
      body: 'Hello {title}',
    });
    expect(mine.placeholders).toEqual(['title']); // parsed on write

    // Source B cannot see it in its own list...
    expect(await svc.list('src_B')).toHaveLength(0);
    // ...nor fetch, update, or archive it by id.
    await expect(svc.get('src_B', mine.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.update('src_B', mine.id, { name: 'hijack' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.archive('src_B', mine.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // The owner still can.
    expect((await svc.get('src_A', mine.id)).name).toBe('Launch');
  });

  it('preview rejects unfilled placeholders but renders when complete', async () => {
    const fake = makeFakePrisma();
    const svc = new NotificationService(fake as any);
    const n = await svc.create('src_A', { name: 'N', body: 'Hi {name}' });

    await expect(svc.preview('src_A', n.id, {})).rejects.toThrow(/name/);
    expect((await svc.preview('src_A', n.id, { name: 'Ada' })).text).toBe(
      'Hi Ada',
    );
  });

  it('createInline hides one-off messages from the gallery but keeps them fetchable', async () => {
    const fake = makeFakePrisma();
    const svc = new NotificationService(fake as any);

    const once = await svc.createInline('src_A', {
      body: 'Reminder for {when}',
      ephemeral: true,
    });
    // Auto-named from the first line, placeholders parsed.
    expect(once.name).toBe('Reminder for {when}');
    expect(once.placeholders).toEqual(['when']);

    // Excluded from the gallery list, but a broadcast can still fetch it by id.
    expect(await svc.list('src_A')).toHaveLength(0);
    expect((await svc.get('src_A', once.id)).id).toBe(once.id);
    // Opt-in flag surfaces it (e.g. the responses screen resolving a name).
    expect(await svc.list('src_A', { includeEphemeral: true })).toHaveLength(1);
  });

  it('duplicate clones within the same Source as a (copy)', async () => {
    const fake = makeFakePrisma();
    const svc = new NotificationService(fake as any);
    const n = await svc.create('src_A', { name: 'Promo', body: 'x {y}' });

    const copy = await svc.duplicate('src_A', n.id);
    expect(copy.name).toBe('Promo (copy)');
    expect(copy.placeholders).toEqual(['y']);
    expect(copy.id).not.toBe(n.id);
  });
});
