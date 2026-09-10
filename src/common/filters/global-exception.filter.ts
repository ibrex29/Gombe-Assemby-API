import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    const requestId = request.id ?? request.headers['x-request-id'];

    // Streaming responses have already flushed headers; writing a JSON body on
    // top would throw inside the filter and mask the original error.
    if (response.headersSent) {
      this.logger.error(
        { requestId, path: request.url, err: exception instanceof Error ? exception.stack : String(exception) },
        'Exception after response started',
      );
      response.end();
      return;
    }

    if (status >= 500) {
      this.logger.error(
        {
          requestId,
          method: request.method,
          path: request.url,
          statusCode: status,
          err: exception instanceof Error ? exception.stack : String(exception),
        },
        'Unhandled exception',
      );
    }

    response.status(status).json({
      statusCode: status,
      message:
        typeof message === 'string'
          ? message
          : ((message as { message?: string | string[] }).message ?? 'Error'),
      requestId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
