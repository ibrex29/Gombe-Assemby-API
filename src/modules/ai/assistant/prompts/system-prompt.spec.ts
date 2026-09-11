import { ContestType } from '@electromon/shared';
import { buildSystemPrompt } from './system-prompt';

describe('buildSystemPrompt races', () => {
  it('names both races and forbids treating one as out of scope', () => {
    const prompt = buildSystemPrompt({
      stateName: 'Gombe',
      campaignName: 'Pantamiyya · Gombe Governorship',
      clientPartyCode: 'PDP',
      isNational: false,
      races: [
        { type: ContestType.GOVERNORSHIP, slug: 'governorship', label: 'Governorship' },
        { type: ContestType.ASSEMBLY, slug: 'assembly', label: 'State House of Assembly' },
      ],
    });

    expect(prompt).toContain('whole Pantamiyya · Gombe Governorship system');
    expect(prompt).toContain('Governorship');
    expect(prompt).toContain('State House of Assembly');
    expect(prompt).toContain('Never say a race is out of scope');
    expect(prompt).toContain('get_race_summary with no contest');
  });
});
