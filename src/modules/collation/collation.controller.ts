import { Body, Controller, Get, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CampaignRole,
  CollationResultStatus,
  COLLATION_READ_ROLES,
  COLLATION_ROLES,
  JwtPayload,
} from '@electromon/shared';
import { CollationService } from './collation.service';
import { CollationBrowseService } from './collation-browse.service';
import {
  CreateCollationResultDto,
  RejectCollationResultDto,
  AttachEc8aPhotoDto,
  ApproveCollationResultDto,
  CommentCollationResultDto,
  ReopenCollationResultDto,
  ScanEc8aDto,
  ScanEc8aResponseDto,
  ScanEc8aFileResponseDto,
} from './dto/collation.dto';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiErrorResponseDto } from '../../common/dto/api-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import { UploadsService } from '../uploads/uploads.service';
import { memoryStorage } from 'multer';
import type { Request } from 'express';

@ApiTags('collation')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('collation')
export class CollationController {
  constructor(
    private collationService: CollationService,
    private browseService: CollationBrowseService,
    private uploadsService: UploadsService,
  ) {}

  @Get('context')
  @ApiOperation({ summary: 'Campaign and state context for dashboard header' })
  getContext(@CurrentUser() user: JwtPayload) {
    return this.browseService.getContext(user);
  }

  @Get('browse/states')
  @ApiOperation({ summary: 'Paginated state list with party totals (national campaigns)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'zone', required: false })
  browseStates(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('zone') zone?: string,
  ) {
    return this.browseService.browseStates(
      user,
      Number(page) || 1,
      Number(limit) || 20,
      search,
      zone,
    );
  }

  @Get('browse/constituencies')
  @ApiOperation({ summary: 'Gombe SHA seats with party totals (assembly contest)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'contest', required: false })
  browseConstituencies(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.browseService.browseConstituencies(
      user,
      Number(page) || 1,
      Number(limit) || 24,
      search,
    );
  }

  @Get('browse/lgas')
  @ApiOperation({ summary: 'Paginated LGA list with party totals (state-scoped)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'stateId', required: false })
  browseLgas(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('stateId') stateId?: string,
  ) {
    return this.browseService.browseLgas(
      user,
      Number(page) || 1,
      Number(limit) || 20,
      search,
      stateId,
    );
  }

  @Get('browse/lgas/:lgaId/wards')
  @ApiOperation({ summary: 'Paginated wards in an LGA with party totals' })
  browseWards(
    @CurrentUser() user: JwtPayload,
    @Param('lgaId') lgaId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.browseService.browseWards(
      user,
      lgaId,
      Number(page) || 1,
      Number(limit) || 20,
      search,
    );
  }

  @Get('browse/my-wards')
  @ApiOperation({ summary: 'Paginated wards for LGA-scoped user' })
  browseMyWards(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.browseService.browseWardsForUser(
      user,
      Number(page) || 1,
      Number(limit) || 20,
      search,
    );
  }

  @Get('browse/wards/:wardId/polling-units')
  @ApiOperation({ summary: 'Paginated polling units in a ward' })
  browsePollingUnits(
    @CurrentUser() user: JwtPayload,
    @Param('wardId') wardId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.browseService.browsePollingUnits(
      user,
      wardId,
      Number(page) || 1,
      Number(limit) || 20,
      search,
    );
  }

  @Get('browse/race-analytics')
  @ApiOperation({ summary: 'Situation Room race board analytics (party standings, LGA outcomes)' })
  raceAnalytics(@CurrentUser() user: JwtPayload) {
    return this.browseService.getRaceAnalytics(user);
  }

  @Get('browse/situation-map')
  @ApiOperation({
    summary:
      'Situation Room map: omit filters for national states; pass region, stateId, lgaId, or wardId to drill Region → State → LGA → Ward → PU',
  })
  @ApiQuery({ name: 'region', required: false })
  @ApiQuery({ name: 'stateId', required: false })
  @ApiQuery({ name: 'lgaId', required: false })
  @ApiQuery({ name: 'wardId', required: false })
  @ApiQuery({ name: 'includeIncidents', required: false, type: Boolean })
  @ApiQuery({ name: 'includeIrevMismatches', required: false, type: Boolean })
  situationMap(
    @CurrentUser() user: JwtPayload,
    @Query('region') region?: string,
    @Query('stateId') stateId?: string,
    @Query('lgaId') lgaId?: string,
    @Query('wardId') wardId?: string,
    @Query('includeIncidents') includeIncidents?: string,
    @Query('includeIrevMismatches') includeIrevMismatches?: string,
  ) {
    return this.browseService.situationMapPoints(user, {
      region,
      stateId,
      lgaId,
      wardId,
      includeIncidents: includeIncidents === '1' || includeIncidents === 'true',
      includeIrevMismatches: includeIrevMismatches === '1' || includeIrevMismatches === 'true',
    });
  }

  @Get('browse/my-polling-units')
  @ApiOperation({
    summary: 'Paginated polling units for ward/LGA/admin users',
    description: 'Supports search, and for state/admin users optional lgaId and wardId filters.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'lgaId', required: false })
  @ApiQuery({ name: 'wardId', required: false })
  @ApiQuery({
    name: 'hasResults',
    required: false,
    description: 'true = only PUs with a collation result; false = only not started',
  })
  browseMyPollingUnits(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('lgaId') lgaId?: string,
    @Query('wardId') wardId?: string,
    @Query('hasResults') hasResults?: string,
  ) {
    const hasResultsFilter =
      hasResults === 'true' ? true : hasResults === 'false' ? false : undefined;
    return this.browseService.browsePollingUnitsForUser(
      user,
      Number(page) || 1,
      Number(limit) || 20,
      search,
      { lgaId, wardId, hasResults: hasResultsFilter },
    );
  }

  @Get('dashboard')
  @Roles(...COLLATION_READ_ROLES)
  @ApiOperation({
    summary: 'Collation dashboard for current user',
    description:
      'Returns dashboard metadata, geographic scope chain, pending approvals, and current result for the logged-in collation officer or campaign admin.',
  })
  @ApiOkResponse({ description: 'Dashboard payload' })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  getDashboard(@CurrentUser() user: JwtPayload) {
    return this.collationService.getDashboard(user);
  }

  @Get('results')
  @Roles(...COLLATION_READ_ROLES)
  @ApiOperation({ summary: 'List collation results for current scope (admins: LGA rollups statewide)' })
  @ApiQuery({ name: 'status', enum: CollationResultStatus, required: false })
  @ApiQuery({ name: 'stateId', required: false })
  @ApiQuery({ name: 'zone', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['name', 'total', 'client', 'turnout', 'updated'] })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ description: 'Collation results' })
  listResults(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: CollationResultStatus,
    @Query('stateId') stateId?: string,
    @Query('zone') zone?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: 'name' | 'total' | 'client' | 'turnout' | 'updated',
    @Query('limit') limit?: string,
  ) {
    return this.collationService.listResults(user, {
      status,
      stateId,
      zone,
      search,
      sort,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('browse/polling-units/:puId/result')
  @Roles(...COLLATION_READ_ROLES)
  @ApiOperation({ summary: 'Read PU collation result (ward/LGA/admin browse)' })
  getPollingUnitResult(@CurrentUser() user: JwtPayload, @Param('puId') puId: string) {
    return this.collationService.getPollingUnitResultForViewer(user, puId);
  }

  @Get('pending-approvals')
  @Roles(
    CampaignRole.WARD_RA_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.NATIONAL_COLLATION_OFFICER,
  )
  @ApiOperation({
    summary: 'List submitted results awaiting approval',
    description: 'Returns results from the level immediately below the current officer scope.',
  })
  @ApiOkResponse({ description: 'Pending approval queue' })
  listPending(@CurrentUser() user: JwtPayload) {
    return this.collationService.listPendingApprovals(user);
  }

  @Get('lga/ward-submissions')
  @Roles(CampaignRole.LGA_COLLATION_OFFICER)
  @ApiOperation({ summary: 'Ward collation submissions in the LGA officer scope' })
  listLgaWardSubmissions(@CurrentUser() user: JwtPayload) {
    return this.collationService.listLgaWardSubmissions(user);
  }

  @Get('lga/wards/:wardId/pu-results')
  @Roles(CampaignRole.LGA_COLLATION_OFFICER)
  @ApiOperation({ summary: 'PU results within a ward (read-only for LGA review)' })
  listLgaWardPuResults(@CurrentUser() user: JwtPayload, @Param('wardId') wardId: string) {
    return this.collationService.listLgaWardPuResults(user, wardId);
  }

  @Get('lga/polling-units/:puId/result')
  @Roles(CampaignRole.LGA_COLLATION_OFFICER)
  @ApiOperation({ summary: 'Single PU collation result in the LGA (read-only)' })
  getLgaPuResult(@CurrentUser() user: JwtPayload, @Param('puId') puId: string) {
    return this.collationService.getLgaPuResult(user, puId);
  }

  @Patch('lga/approve-all-wards')
  @Roles(CampaignRole.LGA_COLLATION_OFFICER)
  @ApiOperation({
    summary: 'Removed: LGA officers no longer approve wards. Ward approval publishes immediately.',
  })
  approveAllLgaWardResults(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ApproveCollationResultDto,
  ) {
    return this.collationService.approveAllLgaWardResults(user, dto);
  }

  @Get('state/lga-submissions')
  @Roles(CampaignRole.STATE_COLLATION_OFFICER)
  @ApiOperation({ summary: 'LGA collation submissions in the state officer scope' })
  listStateLgaSubmissions(@CurrentUser() user: JwtPayload) {
    return this.collationService.listStateLgaSubmissions(user);
  }

  @Get('state/lgas/:lgaId/ward-results')
  @Roles(CampaignRole.STATE_COLLATION_OFFICER)
  @ApiOperation({ summary: 'Ward results within an LGA (read-only for state review)' })
  listStateLgaWardResults(@CurrentUser() user: JwtPayload, @Param('lgaId') lgaId: string) {
    return this.collationService.listStateLgaWardResults(user, lgaId);
  }

  @Patch('state/approve-all-lgas')
  @Roles(CampaignRole.STATE_COLLATION_OFFICER)
  @ApiOperation({
    summary: 'Removed: State officers no longer final-approve LGAs. Ward approval publishes immediately.',
  })
  approveAllStateLgaResults(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ApproveCollationResultDto,
  ) {
    return this.collationService.approveAllStateLgaResults(user, dto);
  }

  @Patch('lga/resubmit-to-state')
  @Roles(CampaignRole.LGA_COLLATION_OFFICER)
  @ApiOperation({
    summary:
      'Re-forward LGA rollup to state after state return (requires every ward in the LGA approved)',
  })
  resubmitLgaToState(@CurrentUser() user: JwtPayload) {
    return this.collationService.resubmitLgaToState(user);
  }

  @Patch('results/:id/reopen')
  @Roles(CampaignRole.STATE_COLLATION_OFFICER, CampaignRole.CAMPAIGN_DIRECTOR, CampaignRole.CANDIDATE)
  @ApiOperation({ summary: 'Reopen a state-finalized LGA result for controlled correction' })
  reopenCollationResult(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReopenCollationResultDto,
  ) {
    return this.collationService.reopenCollationResult(user, id, dto.reason);
  }

  @Get('ward/pu-submissions')
  @Roles(CampaignRole.WARD_RA_OFFICER)
  @ApiOperation({
    summary: 'Paginated PU collation submissions in the ward officer scope',
    description:
      'Omit `contest` to receive both Governorship and House of Assembly sheets grouped per polling unit. Pass `contest` to keep the single-contest list used by mobile.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'NOT_STARTED'],
  })
  @ApiQuery({ name: 'contest', required: false, type: String })
  listWardPuSubmissions(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: CollationResultStatus | 'NOT_STARTED',
    @Query('contest') contest?: string,
  ) {
    return this.collationService.listWardPuSubmissions(user, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      status,
      allContests: !contest?.trim(),
    });
  }

  @Patch('ward/resubmit-to-lga')
  @Roles(CampaignRole.WARD_RA_OFFICER)
  @ApiOperation({
    summary:
      'Re-forward ward rollup to LGA after LGA return (requires every PU in the ward approved)',
  })
  resubmitWardToLga(@CurrentUser() user: JwtPayload) {
    return this.collationService.resubmitWardToLga(user);
  }

  @Patch('ward/return-flagged-pus')
  @Roles(CampaignRole.WARD_RA_OFFICER)
  @ApiOperation({
    summary:
      'Return all LGA-flagged polling units to PU agents after LGA returned the ward',
  })
  returnLgaFlaggedPus(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RejectCollationResultDto,
  ) {
    return this.collationService.returnLgaFlaggedPus(user, dto);
  }

  @Post('results')
  @Roles(...COLLATION_ROLES)
  @ApiOperation({ summary: 'Create or update draft collation result at current scope' })
  upsertResult(@CurrentUser() user: JwtPayload, @Body() dto: CreateCollationResultDto) {
    return this.collationService.upsertResult(user, dto);
  }

  @Patch('results/:id/submit')
  @Roles(...COLLATION_ROLES)
  @ApiOperation({ summary: 'Submit draft result for approval at the next level' })
  submitResult(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.collationService.submitResult(user, id);
  }

  @Patch('results/:id/ec8a')
  @Roles(...COLLATION_ROLES)
  @ApiOperation({ summary: 'Attach an uploaded EC8A form photo to a draft result' })
  attachEc8a(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: AttachEc8aPhotoDto,
  ) {
    return this.collationService.attachEc8aPhoto(user, id, dto.photoUrl);
  }

  @Post('ec8a/scan')
  @Roles(...COLLATION_ROLES)
  @ApiOperation({
    summary: 'OCR an already-uploaded EC8A photo (JSON photoUrl)',
    description:
      'For web or when you already have `/uploads/{id}`. Mobile apps should prefer `POST /collation/ec8a/scan-file`.',
  })
  @ApiOkResponse({ type: ScanEc8aResponseDto })
  scanEc8a(@CurrentUser() user: JwtPayload, @Body() dto: ScanEc8aDto) {
    return this.collationService.scanEc8aPhoto(user, dto.photoUrl);
  }

  @Post('ec8a/scan-file')
  @Roles(...COLLATION_ROLES)
  @ApiTags('mobile')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Mobile: upload EC8A photo and return OCR figures in one call',
    description: [
      'Send the camera JPEG as multipart field `file`.',
      'Returns `photoUrl` plus EC8A `fields` and `partyResults` to pre-fill the agent form.',
      'Agent must still review/edit, then `POST /collation/results` and `PATCH /collation/results/:id/submit`.',
      'Wait up to ~25s. JPEG/PNG, max 5 MB. PDFs are not OCR’d.',
    ].join('\n\n'),
  })
  @ApiOkResponse({ type: ScanEc8aFileResponseDto })
  async scanEc8aFile(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    const uploaded = await this.uploadsService.saveFile(file, req);
    const scan = await this.collationService.scanEc8aPhoto(user, uploaded.url);
    return {
      ...scan,
      photoUrl: uploaded.url,
      url: uploaded.url,
      filename: uploaded.filename,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
    };
  }

  @Patch('results/:id/approve')
  @Roles(CampaignRole.WARD_RA_OFFICER)
  @ApiOperation({
    summary: 'Ward officer: approve a submitted PU result. Published immediately to Situation Room.',
  })
  approveResult(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ApproveCollationResultDto,
  ) {
    return this.collationService.approveResult(user, id, dto);
  }

  @Post('results/:id/comments')
  @Roles(
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.NATIONAL_COLLATION_OFFICER,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.CANDIDATE,
  )
  @ApiOperation({
    summary:
      'Add a review comment on a result without changing its status or Situation Room totals.',
  })
  commentResult(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CommentCollationResultDto,
  ) {
    return this.collationService.commentResult(user, id, dto.comment);
  }

  @Patch('results/:id/reject')
  @Roles(
    CampaignRole.WARD_RA_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.NATIONAL_COLLATION_OFFICER,
  )
  @ApiOperation({
    summary:
      'Request correction / return a result. Ward officers return PU submissions. LGA and State reviewers may return already-published results in their scope.',
  })
  rejectResult(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectCollationResultDto,
  ) {
    return this.collationService.rejectResult(user, id, dto);
  }

  @Get('results/:id/action-logs')
  @Roles(...COLLATION_READ_ROLES)
  @ApiOperation({ summary: 'Action log for submit / approve / reject / comment on a collation result' })
  listActionLogs(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.collationService.listActionLogs(user, id);
  }
}
