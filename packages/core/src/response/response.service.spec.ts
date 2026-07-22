import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InteractionType } from '@paedavic/database';
import { ResponseService } from './response.service';

/**
 * In-memory Prisma covering the reads/writes ResponseService performs. Enough to
 * prove interaction-type gating, active-subscriber enforcement, upsert
 * (latest-wins), tallies, and the fire-and-forget owner ping.
 */
function makeFake() {
  const broadcasts: any[] = [
    {
      id: 'b_poll',
      sourceId: 'src_A',
      notificationId: 'n1',
      interaction: InteractionType.poll,
      pollOptions: ['Yes', 'No'],
    },
    {
      id: 'b_q',
      sourceId: 'src_A',
      notificationId: 'n1',
      interaction: InteractionType.question,
      pollOptions: [],
    },
    {
      id: 'b_plain',
      sourceId: 'src_A',
      notificationId: 'n1',
      interaction: InteractionType.none,
      pollOptions: [],
    },
  ];
  const subscribers: any[] = [
    { id: 's1', sourceId: 'src_A', telegramUserId: 111n, username: 'ada', status: 'active' },
    { id: 's2', sourceId: 'src_A', telegramUserId: 222n, username: null, status: 'unsubscribed' },
  ];
  const sources: any[] = [{ id: 'src_A', telegramUserId: 999n }];
  const notifications: any[] = [{ id: 'n1', name: 'Weekly check-in' }];
  const responses: any[] = [];

  const prisma = {
    responses,
    broadcast: {
      findUnique: async ({ where }: any) => broadcasts.find((b) => b.id === where.id) ?? null,
      findFirst: async ({ where }: any) =>
        broadcasts.find((b) => b.id === where.id && b.sourceId === where.sourceId) ?? null,
    },
    subscriber: {
      findUnique: async ({ where }: any) => {
        const { sourceId, telegramUserId } = where.sourceId_telegramUserId;
        return (
          subscribers.find(
            (s) => s.sourceId === sourceId && s.telegramUserId === telegramUserId,
          ) ?? null
        );
      },
    },
    source: {
      findUnique: async ({ where }: any) => sources.find((s) => s.id === where.id) ?? null,
    },
    notification: {
      findUnique: async ({ where }: any) =>
        notifications.find((n) => n.id === where.id) ?? null,
    },
    broadcastResponse: {
      upsert: async ({ where, create, update }: any) => {
        const { broadcastId, subscriberId } = where.broadcastId_subscriberId;
        const existing = responses.find(
          (r) => r.broadcastId === broadcastId && r.subscriberId === subscriberId,
        );
        if (existing) Object.assign(existing, update);
        else
          responses.push({
            id: `r_${responses.length + 1}`,
            createdAt: new Date(),
            optionIndex: null,
            text: null,
            ...create,
          });
      },
      findMany: async ({ where }: any) =>
        responses
          .filter((r) => r.broadcastId === where.broadcastId)
          .map((r) => ({
            ...r,
            subscriber: subscribers.find((s) => s.id === r.subscriberId),
          })),
    },
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const telegram = { enabled: true, sendText: jest.fn().mockResolvedValue(undefined) };
  const svc = new ResponseService(prisma as any, audit as any, telegram as any);
  return { svc, prisma, audit, telegram, responses };
}

describe('ResponseService', () => {
  it('records a poll vote, pings the owner, returns the label', async () => {
    const { svc, responses, telegram } = makeFake();
    const { label } = await svc.recordVote('b_poll', 111, 0);

    expect(label).toBe('Yes');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ subscriberId: 's1', optionIndex: 0 });
    // owner (telegramUserId 999) pinged once
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText.mock.calls[0][0]).toBe(999);
  });

  it('changes a vote (latest wins) instead of adding a second row', async () => {
    const { svc, responses } = makeFake();
    await svc.recordVote('b_poll', 111, 0);
    await svc.recordVote('b_poll', 111, 1);
    expect(responses).toHaveLength(1);
    expect(responses[0].optionIndex).toBe(1);
  });

  it('rejects an out-of-range option', async () => {
    const { svc } = makeFake();
    await expect(svc.recordVote('b_poll', 111, 5)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a vote on a non-poll broadcast', async () => {
    const { svc } = makeFake();
    await expect(svc.recordVote('b_q', 111, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a response from a non-subscriber / unsubscribed user', async () => {
    const { svc } = makeFake();
    await expect(svc.recordVote('b_poll', 333, 0)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.recordVote('b_poll', 222, 0)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('records a free-text answer and trims it', async () => {
    const { svc, responses } = makeFake();
    await svc.recordText('b_q', 111, '  hello there  ');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ subscriberId: 's1', text: 'hello there' });
  });

  it('rejects an empty answer', async () => {
    const { svc } = makeFake();
    await expect(svc.recordText('b_q', 111, '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('lists responses with poll tallies', async () => {
    const { svc } = makeFake();
    await svc.recordVote('b_poll', 111, 0);
    const out = await svc.list('src_A', 'b_poll');

    expect(out.interaction).toEqual({ type: 'poll', options: ['Yes', 'No'] });
    expect(out.responses).toHaveLength(1);
    expect(out.responses[0]).toMatchObject({ telegramUserId: '111', username: 'ada' });
    expect(out.tallies).toEqual([
      { optionIndex: 0, label: 'Yes', count: 1 },
      { optionIndex: 1, label: 'No', count: 0 },
    ]);
  });
});
