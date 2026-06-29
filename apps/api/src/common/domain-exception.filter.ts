import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { UnfilledPlaceholdersError } from '@paedavic/core';

/**
 * Maps transport-agnostic domain errors thrown by the service layer onto HTTP
 * responses, so core stays free of HTTP concerns. Nest's own HttpExceptions
 * pass through untouched.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();

    if (exception instanceof UnfilledPlaceholdersError) {
      res.status(HttpStatus.BAD_REQUEST).send({
        statusCode: HttpStatus.BAD_REQUEST,
        message: exception.message,
        missing: exception.missing,
      });
      return;
    }

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).send(exception.getResponse());
      return;
    }

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
