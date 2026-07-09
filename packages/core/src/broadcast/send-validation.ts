import { NotFoundException } from '@nestjs/common';
import { type Group, type Notification, PrismaService } from '@paedavic/database';
import { renderTemplate } from '../notification/placeholder.util';

export interface SendTargetsInput {
  notificationId: string;
  groupIds: string[];
  placeholderValues: Record<string, string>;
}

/**
 * Validate the preconditions shared by an immediate broadcast (`BroadcastService`)
 * and a scheduled one (`ScheduleService`), all tenant-scoped:
 *  - the notification exists in THIS source and isn't archived,
 *  - every placeholder can be filled (render dry-run — throws if not),
 *  - all target groups exist in THIS source.
 *
 * Returns the resolved rows (deduped `groupIds`, the `groups`, the `notification`).
 * Kept as one function so the "what makes a valid send" rule can't drift between
 * the two callers. Throws NotFoundException / UnfilledPlaceholdersError.
 */
export async function resolveSendTargets(
  prisma: PrismaService,
  sourceId: string,
  input: SendTargetsInput,
): Promise<{ notification: Notification; groups: Group[]; groupIds: string[] }> {
  const notification = await prisma.notification.findFirst({
    where: { id: input.notificationId, sourceId, archivedAt: null },
  });
  if (!notification) throw new NotFoundException('Notification not found');
  renderTemplate(notification.body, input.placeholderValues); // throws if unfilled

  const groupIds = [...new Set(input.groupIds)];
  const groups = await prisma.group.findMany({
    where: { id: { in: groupIds }, sourceId },
  });
  if (groups.length !== groupIds.length) {
    throw new NotFoundException('One or more target groups not found');
  }
  return { notification, groups, groupIds };
}
