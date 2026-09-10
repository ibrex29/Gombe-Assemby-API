import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class CampaignService {
  constructor(private prisma: PrismaService) {}

  listForUser(userId: string) {
    return this.prisma.campaign.findMany({
      where: {
        memberships: { some: { userId, isActive: true } },
      },
      include: {
        state: true,
        _count: {
          select: {
            supportGroups: true,
            volunteers: true,
            fieldReports: true,
          },
        },
      },
    });
  }

  async findById(id: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        state: {
          include: {
            lgas: {
              include: {
                wards: {
                  include: {
                    _count: { select: { pollingUnits: true } },
                  },
                },
              },
            },
            senatorialDistricts: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    return campaign;
  }
}
