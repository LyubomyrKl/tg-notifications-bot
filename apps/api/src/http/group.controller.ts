import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AddMembersInput,
  CreateGroupInput,
  type GroupView,
  RenameGroupInput,
  type SubscriberView,
} from '@paedavic/contracts';
import { type AuthPrincipal, GroupService } from '@paedavic/core';
import { BearerAuthGuard } from '../auth/bearer-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Groups + membership. All routes tenant-scoped via the resolved principal. */
@Controller('groups')
@UseGuards(BearerAuthGuard)
export class GroupController {
  constructor(private readonly groups: GroupService) {}

  @Post()
  create(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateGroupInput)) body: CreateGroupInput,
  ): Promise<GroupView> {
    return this.groups.create(p.sourceId, body.name);
  }

  @Get()
  list(@CurrentPrincipal() p: AuthPrincipal): Promise<GroupView[]> {
    return this.groups.list(p.sourceId);
  }

  @Get(':id/members')
  members(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<SubscriberView[]> {
    return this.groups.members(p.sourceId, id);
  }

  @Patch(':id')
  rename(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RenameGroupInput)) body: RenameGroupInput,
  ): Promise<GroupView> {
    return this.groups.rename(p.sourceId, id, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.groups.delete(p.sourceId, id);
  }

  @Post(':id/members')
  addMembers(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddMembersInput)) body: AddMembersInput,
  ): Promise<GroupView> {
    return this.groups.addMembers(p.sourceId, id, body.subscriberIds);
  }

  @Delete(':id/members/:subscriberId')
  removeMember(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
    @Param('subscriberId') subscriberId: string,
  ): Promise<GroupView> {
    return this.groups.removeMember(p.sourceId, id, subscriberId);
  }
}
