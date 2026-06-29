import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateSourceInput,
  SourceCredentials,
  SourceView,
} from '@paedavic/contracts';
import { PrismaService, type Source } from '@paedavic/database';
import { TelegramService } from '@paedavic/telegram';
import type { AuthPrincipal } from '../auth/principal';
import {
  generateApiKey,
  generateToken,
  hashApiKey,
  hashPassword,
} from '../crypto/crypto.util';

/**
 * Workspace lifecycle + the resolution layer that turns any transport identity
 * (API key, Telegram id, web user) into a tenant-scoped {@link AuthPrincipal}.
 * Provisioning, Telegram linking, and views all live here so REST controllers
 * and bot handlers share one implementation.
 */
@Injectable()
export class SourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * Admin bootstrap (POST /sources): find-or-create the owner account, then
   * create a workspace with a fresh API key + start token. The raw API key is
   * returned ONCE here and never again.
   */
  async provision(input: CreateSourceInput): Promise<SourceCredentials> {
    const owner = await this.prisma.user.upsert({
      where: { email: input.ownerEmail },
      update: {},
      create: {
        email: input.ownerEmail,
        passwordHash: await hashPassword(input.ownerPassword),
      },
    });

    const apiKey = generateApiKey();
    const source = await this.prisma.source.create({
      data: {
        name: input.name,
        ownerId: owner.id,
        apiKeyHash: apiKey.hash,
        startToken: generateToken(),
        // Every workspace ships with the implicit "All" group.
        groups: { create: { name: 'All', isAll: true } },
      },
    });

    return { ...this.toView(source), apiKey: apiKey.key };
  }

  /**
   * Idempotently bind a Telegram identity to a workspace via its start token.
   * Reopening the same deep-link is a no-op; a token already bound to a
   * different Telegram account is rejected.
   */
  async linkTelegram(
    startToken: string,
    telegramUserId: bigint,
  ): Promise<Source> {
    const source = await this.prisma.source.findFirst({
      where: { startToken, archivedAt: null },
    });
    if (!source) {
      throw new NotFoundException('Invalid or expired start link');
    }

    // Already linked to this exact account → idempotent success.
    if (source.telegramUserId === telegramUserId) return source;

    if (source.telegramUserId !== null) {
      throw new ConflictException(
        'This workspace is already linked to another Telegram account',
      );
    }

    // The Telegram account may already own a different workspace (unique).
    const clash = await this.prisma.source.findUnique({
      where: { telegramUserId },
    });
    if (clash) {
      throw new ConflictException(
        'This Telegram account is already linked to another workspace',
      );
    }

    return this.prisma.source.update({
      where: { id: source.id },
      data: { telegramUserId },
    });
  }

  // ── Resolution: identity → tenant-scoped principal ────────────────────────

  async resolveByApiKey(rawKey: string): Promise<AuthPrincipal | null> {
    const source = await this.prisma.source.findFirst({
      where: { apiKeyHash: hashApiKey(rawKey), archivedAt: null },
    });
    return source
      ? { sourceId: source.id, userId: source.ownerId, via: 'apiKey' }
      : null;
  }

  async resolveByTelegramId(
    telegramUserId: bigint,
  ): Promise<AuthPrincipal | null> {
    const source = await this.prisma.source.findFirst({
      where: { telegramUserId, archivedAt: null },
    });
    return source
      ? { sourceId: source.id, userId: source.ownerId, via: 'telegram' }
      : null;
  }

  /** Resolve the active workspace owned by a web user (JWT path). */
  async resolveByUserId(userId: string): Promise<AuthPrincipal | null> {
    const source = await this.prisma.source.findFirst({
      where: { ownerId: userId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return source
      ? { sourceId: source.id, userId, via: 'jwt' }
      : null;
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  async getView(sourceId: string): Promise<SourceView> {
    const source = await this.prisma.source.findUnique({
      where: { id: sourceId },
    });
    if (!source) throw new NotFoundException('Source not found');
    return this.toView(source);
  }

  toView(source: Source): SourceView {
    return {
      id: source.id,
      name: source.name,
      telegramUserId: source.telegramUserId?.toString() ?? null,
      telegramLinked: source.telegramUserId !== null,
      startLink: this.telegram.buildStartLink(source.startToken),
      archivedAt: source.archivedAt?.toISOString() ?? null,
      createdAt: source.createdAt.toISOString(),
    };
  }
}
