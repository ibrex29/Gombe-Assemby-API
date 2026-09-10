import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { StructureService } from './structure.service';
import {
  CoverageStatsDto,
  LgaResponseDto,
  PollingUnitResponseDto,
  StateResponseDto,
  WardResponseDto,
} from './dto/structure-response.dto';
import { ApiErrorResponseDto } from '../../common/dto/api-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';

@ApiTags('structure')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('structure')
export class StructureController {
  constructor(private structureService: StructureService) {}

  @Get('states')
  @ApiOperation({
    summary: 'List all states',
    description: 'Returns all 37 Nigerian states (+ FCT) with LGA and campaign counts.',
  })
  @ApiOkResponse({ type: [StateResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  getStates() {
    return this.structureService.getStates();
  }

  @Get('states/:stateId/lgas')
  @ApiOperation({
    summary: 'List LGAs in a state',
    description: 'Returns local government areas with senatorial district and ward counts.',
  })
  @ApiParam({ name: 'stateId', description: 'State ID', example: 'cms147za8001xww9ktd46y7m0' })
  @ApiOkResponse({ type: [LgaResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  getLgas(@Param('stateId') stateId: string) {
    return this.structureService.getLgasByState(stateId);
  }

  @Get('lgas/:lgaId/wards')
  @ApiOperation({
    summary: 'List wards in an LGA',
    description: 'Returns wards with polling unit and volunteer counts.',
  })
  @ApiParam({ name: 'lgaId', description: 'LGA ID' })
  @ApiOkResponse({ type: [WardResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  getWards(@Param('lgaId') lgaId: string) {
    return this.structureService.getWardsByLga(lgaId);
  }

  @Get('wards/:wardId/polling-units')
  @ApiOperation({
    summary: 'List polling units in a ward',
    description: 'Returns all polling units for a given ward.',
  })
  @ApiParam({ name: 'wardId', description: 'Ward ID' })
  @ApiOkResponse({ type: [PollingUnitResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  getPollingUnits(@Param('wardId') wardId: string) {
    return this.structureService.getPollingUnitsByWard(wardId);
  }

  @Get('collation-hierarchy')
  @ApiOperation({
    summary: 'Electoral collation hierarchy',
    description:
      'Returns the 5-level approval chain: PU → Ward/RA → LGA → State Collation → National Collation (Abuja).',
  })
  @ApiOkResponse({ description: 'Collation hierarchy levels' })
  getCollationHierarchy() {
    return this.structureService.getCollationHierarchy();
  }

  @Get('coverage')
  @ApiOperation({
    summary: 'Get campaign structure coverage stats',
    description: 'Returns total LGAs, wards, polling units, and assigned coordinators for a campaign.',
  })
  @ApiQuery({
    name: 'campaignId',
    required: true,
    description: 'Campaign ID',
    example: 'cms147z3t001www9ktkqgluw0',
  })
  @ApiOkResponse({ type: CoverageStatsDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  getCoverage(@Query('campaignId') campaignId: string) {
    return this.structureService.getCoverageStats(campaignId);
  }
}
