import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  type AuthResult,
  LoginInput,
  RegisterInput,
  type RegisterResult,
} from '@paedavic/contracts';
import { AuthService } from '@paedavic/core';
import { SuperAdminGuard } from '../auth/super-admin.guard';
import { AuthThrottleGuard } from '../common/throttle.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Web-dashboard auth. Thin: parse → call service → return. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Provisions a full account + workspace, so it's a platform-operator action —
   * gated by the super-admin key, not open self-serve. (A future public dashboard
   * signup would be its own separate, rate-limited route.) Returns the workspace
   * API key exactly once.
   */
  @Post('register')
  @UseGuards(SuperAdminGuard)
  register(
    @Body(new ZodValidationPipe(RegisterInput)) body: RegisterInput,
  ): Promise<RegisterResult> {
    return this.auth.register(body);
  }

  @Post('login')
  @UseGuards(AuthThrottleGuard)
  login(
    @Body(new ZodValidationPipe(LoginInput)) body: LoginInput,
  ): Promise<AuthResult> {
    return this.auth.login(body);
  }
}
