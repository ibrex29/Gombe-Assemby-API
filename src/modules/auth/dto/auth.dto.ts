import { IsEmail, IsNotEmpty, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: '+2348000000004',
    description: 'Registered phone number (e.g. +2348… or 080…)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[\d+\s\-()]+$/, {
    message: 'phoneNumber must be a valid phone number',
  })
  phoneNumber: string;

  @ApiProperty({
    example: '1234567890',
    minLength: 8,
    description: 'Account password (minimum 8 characters)',
  })
  @IsString()
  @MinLength(8)
  password: string;
}

export class RefreshTokenDto {
  @ApiProperty({
    example: '8074ffa26b5199ff401b29bad6ce4061cc5c49892821435df994085521c324c8351a17183072c0b46ec6323a0e9f9251',
    description: 'Refresh token received from login or refresh response',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'coordinator@electromon.ng' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'SecurePass123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'Ahmadu' })
  @IsString()
  firstName: string;

  @ApiProperty({ example: 'Ibrahim' })
  @IsString()
  lastName: string;

  @ApiProperty({ example: '+2348000000002', description: 'Required for phone-based login' })
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'ChangeMe123!' })
  @IsString()
  currentPassword: string;

  @ApiProperty({ example: 'NewSecurePass123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}
