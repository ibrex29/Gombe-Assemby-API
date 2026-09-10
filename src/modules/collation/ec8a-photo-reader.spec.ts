import { isLandscapeScan } from './ec8a-photo-reader.service';

describe('ec8a-photo-reader landscape detection', () => {
  it('treats wide IReV scans as landscape', () => {
    expect(isLandscapeScan(2600, 1800)).toBe(true);
    expect(isLandscapeScan(2000, 1800)).toBe(false);
    expect(isLandscapeScan(0, 100)).toBe(false);
  });
});
