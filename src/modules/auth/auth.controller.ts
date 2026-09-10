import { Body, Controller, Get, Ip, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshTokenDto, RegisterDto } from './dto/auth.dto';
import {
  LoginResponseDto,
  RefreshTokenResponseDto,
  RegisterResponseDto,
  SessionResponseDto,
} from './dto/auth-response.dto';
import { ApiErrorResponseDto, MessageResponseDto } from '../../common/dto/api-response.dto';
import { Public } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import type { JwtPayload } from '@electromon/shared';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({
    summary: 'Login with phone number and password',
    description: 'Returns JWT access token, refresh token, and user profile with campaign role.',
  })
  @ApiOkResponse({ type: LoginResponseDto, description: 'Login successful' })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto, description: 'Validation error' })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto, description: 'Invalid credentials' })
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.authService.login(dto, ip);
  }

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Register a new user',
    description: 'Creates a user account. Campaign membership must be assigned separately.',
  })
  @ApiOkResponse({ type: RegisterResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto, description: 'User already exists' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('refresh')
  @ApiOperation({
    summary: 'Refresh access token',
    description: 'Exchange a valid refresh token for a new access + refresh token pair.',
  })
  @ApiOkResponse({ type: RefreshTokenResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto, description: 'Invalid refresh token' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @ApiOperation({
    summary: 'Logout and revoke refresh token',
    description: 'Invalidates the provided refresh token. Does not require a valid access token.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('session')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({
    summary: 'Get current user session',
    description: 'Returns user profile and all active campaign memberships.',
  })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  session(@CurrentUser() user: JwtPayload) {
    return this.authService.getSession(user.sub);
  }
}
