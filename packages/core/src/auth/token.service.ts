import { Injectable, UnauthorizedException } from '@nestjs/common';
import { loadConfig } from '@paedavic/config';
import jwt from 'jsonwebtoken';

export interface SessionClaims {
  /** User id (subject). */
  sub: string;
}

/** Signs and verifies dashboard session JWTs (email/password login). */
@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly expiresIn: string;

  constructor() {
    const cfg = loadConfig();
    this.secret = cfg.JWT_SECRET;
    this.expiresIn = cfg.JWT_EXPIRES_IN;
  }

  sign(userId: string): string {
    return jwt.sign({ sub: userId }, this.secret, {
      expiresIn: this.expiresIn,
    } as jwt.SignOptions);
  }

  verify(token: string): SessionClaims {
    try {
      const decoded = jwt.verify(token, this.secret) as SessionClaims;
      if (!decoded?.sub) throw new Error('missing subject');
      return decoded;
    } catch {
      throw new UnauthorizedException('Invalid or expired session token');
    }
  }
}
