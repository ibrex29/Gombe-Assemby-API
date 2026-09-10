import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { FieldReportType } from '@electromon/shared';
import { CreateFieldReportDto } from './dto/field-report.dto';

describe('CreateFieldReportDto voice incidents', () => {
  it('accepts audio-only incident reports', async () => {
    const dto = plainToInstance(CreateFieldReportDto, {
      campaignId: 'camp-1',
      type: FieldReportType.INCIDENT,
      audioUrl: 'https://cdn.example.com/voice.m4a',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('still requires incidentType for form reports', async () => {
    const dto = plainToInstance(CreateFieldReportDto, {
      campaignId: 'camp-1',
      type: FieldReportType.INCIDENT,
      title: 'Violence',
      description: 'There was violence at the unit.',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'incidentType')).toBe(true);
  });
});
