import * as dbEnums from '@electromon/db';
import { SocialPlatform, SocialSentiment } from '@electromon/shared';

/**
 * Enums are declared twice — once in schema.prisma and once in
 * shared/src/enums.ts — and nothing links them. Adding a value to one and
 * forgetting the other produces a mismatch that only shows up at runtime, so it
 * is asserted here instead.
 */
describe('shared enums match the generated Prisma enums', () => {
  it.each([
    ['SocialPlatform', SocialPlatform],
    ['SocialSentiment', SocialSentiment],
  ])('%s', (name, sharedEnum) => {
    const generated = (dbEnums as Record<string, unknown>)[name] as
      Record<string, string> | undefined;

    expect(generated).toBeDefined();
    expect(Object.values(sharedEnum as Record<string, string>).sort()).toEqual(
      Object.values(generated!).sort(),
    );
  });
});
