import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class RefreshBulkDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  resultIds!: string[];
}
