import { Body, Controller, Post } from '@nestjs/common';
import {
  type AuthResult,
  LoginInput,
  RegisterInput,
} from '@paedavic/contracts';
import { AuthService } from '@paedavic/core';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Web-dashboard auth. Thin: parse → call service → return. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(
    @Body(new ZodValidationPipe(RegisterInput)) body: RegisterInput,
  ): Promise<AuthResult> {
    return this.auth.register(body);
  }

  @Post('login')
  login(
    @Body(new ZodValidationPipe(LoginInput)) body: LoginInput,
  ): Promise<AuthResult> {
    return this.auth.login(body);
  }
}
