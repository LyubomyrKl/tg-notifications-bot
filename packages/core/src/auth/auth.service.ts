import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AuthResult,
  LoginInput,
  RegisterInput,
} from '@paedavic/contracts';
import { PrismaService } from '@paedavic/database';
import {
  generateApiKey,
  generateToken,
  hashPassword,
  verifyPassword,
} from '../crypto/crypto.util';
import { TokenService } from './token.service';

/**
 * Web-dashboard authentication (email/password → JWT). Registration also
 * provisions the user's first workspace so a fresh account is immediately
 * usable. The resulting JWT, like every other transport, resolves to a
 * tenant-scoped principal downstream.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async register(input: RegisterInput): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    if (existing) throw new ConflictException('Email already registered');

    const apiKey = generateApiKey();
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: await hashPassword(input.password),
        sources: {
          create: {
            name: input.workspaceName,
            apiKeyHash: apiKey.hash,
            startToken: generateToken(),
          },
        },
      },
      include: { sources: true },
    });

    const source = user.sources[0];
    return {
      token: this.tokens.sign(user.id),
      user: { id: user.id, email: user.email },
      source: { id: source.id, name: source.name },
    };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: {
        sources: {
          where: { archivedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const source = user.sources[0];
    if (!source) {
      throw new UnauthorizedException('Account has no active workspace');
    }

    return {
      token: this.tokens.sign(user.id),
      user: { id: user.id, email: user.email },
      source: { id: source.id, name: source.name },
    };
  }
}
