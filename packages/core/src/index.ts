// Service layer — the single source of truth for every Source action.
export { CoreModule } from './core.module';

export { SourceModule } from './source/source.module';
export { SourceService } from './source/source.service';

export { AuthModule } from './auth/auth.module';
export { AuthService } from './auth/auth.service';
export { TokenService } from './auth/token.service';
export type { SessionClaims } from './auth/token.service';

export type { AuthPrincipal } from './auth/principal';

export {
  hashPassword,
  verifyPassword,
  generateApiKey,
  hashApiKey,
  generateToken,
} from './crypto/crypto.util';
