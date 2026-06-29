import { ConflictException } from '@nestjs/common';
import type { Source } from '@paedavic/database';
import { hashApiKey } from '../crypto/crypto.util';
import { SourceService } from './source.service';

/**
 * In-memory Prisma stand-in supporting exactly the queries SourceService runs.
 * Lets us prove tenant isolation + Telegram-link idempotency without a DB.
 */
function makeFakePrisma(seed: Source[]) {
  const sources = [...seed];
  const matches = (s: Source, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'archivedAt') return s.archivedAt === v;
      return (s as Record<string, unknown>)[k] === v;
    });
  return {
    sources,
    source: {
      findFirst: async ({ where }: any) =>
        sources.find((s) => matches(s, where)) ?? null,
      findUnique: async ({ where }: any) =>
        sources.find((s) => matches(s, where)) ?? null,
      update: async ({ where, data }: any) => {
        const s = sources.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
    },
  };
}

const baseSource = (over: Partial<Source>): Source => ({
  id: 'src_1',
  name: 'WS',
  ownerId: 'usr_1',
  telegramUserId: null,
  apiKeyHash: 'h',
  startToken: 'tok',
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const telegram = { buildStartLink: (t: string) => `https://t.me/bot?start=${t}` };

describe('SourceService', () => {
  describe('linkTelegram (idempotency)', () => {
    it('binds an unlinked workspace, then is a no-op on reopen', async () => {
      const fake = makeFakePrisma([baseSource({ startToken: 'tok' })]);
      const svc = new SourceService(fake as any, telegram as any);

      const first = await svc.linkTelegram('tok', 555n);
      expect(first.telegramUserId).toBe(555n);

      const second = await svc.linkTelegram('tok', 555n); // reopen same link
      expect(second.telegramUserId).toBe(555n);
      expect(fake.sources).toHaveLength(1); // no duplicate workspace
    });

    it('rejects binding a token already linked to another account', async () => {
      const fake = makeFakePrisma([
        baseSource({ startToken: 'tok', telegramUserId: 100n }),
      ]);
      const svc = new SourceService(fake as any, telegram as any);

      await expect(svc.linkTelegram('tok', 999n)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('resolveByApiKey (tenant isolation)', () => {
    it('resolves only the workspace owning the key, never a sibling', async () => {
      const keyA = 'pk_aaa';
      const keyB = 'pk_bbb';
      const fake = makeFakePrisma([
        baseSource({ id: 'src_A', apiKeyHash: hashApiKey(keyA) }),
        baseSource({ id: 'src_B', apiKeyHash: hashApiKey(keyB) }),
      ]);
      const svc = new SourceService(fake as any, telegram as any);

      expect((await svc.resolveByApiKey(keyA))?.sourceId).toBe('src_A');
      expect((await svc.resolveByApiKey(keyB))?.sourceId).toBe('src_B');
      expect(await svc.resolveByApiKey('pk_unknown')).toBeNull();
    });
  });
});
