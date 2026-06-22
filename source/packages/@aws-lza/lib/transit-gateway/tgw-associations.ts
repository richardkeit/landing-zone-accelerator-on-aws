/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

/**
 * @fileoverview TGW route table association management.
 *
 * Handles the 1:1 constraint: an attachment can only be associated to one
 * route table at a time. Disassociations run before new associations.
 */

import {
  AssociateTransitGatewayRouteTableCommand,
  DisassociateTransitGatewayRouteTableCommand,
  GetTransitGatewayRouteTableAssociationsCommand,
  DescribeTransitGatewayAttachmentsCommand,
  EC2Client,
  type TransitGatewayRouteTableAssociation,
  type TransitGatewayAttachmentAssociation,
} from '@aws-sdk/client-ec2';
import path from 'node:path';
import { createLogger } from '../common/logger';
import { executeApi } from '../common/utility';
import { waitUntil } from '../../common/functions';
import { findAttachmentName } from './functions';
import { IDesiredAttachment, ITgwAssociationResponse, TgwOperationResult } from './interfaces';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

/**
 * Abstract class for managing TGW route table associations.
 *
 * Handles the 1:1 constraint: an attachment can only be associated to one
 * route table at a time. Disassociations run before new associations.
 */
export abstract class TgwAssociations {
  /**
   * Processes associations for a single route table: queries current state,
   * diffs against desired, and executes disassociations then associations.
   * @param ec2 - EC2 client for the TGW owner account
   * @param routeTableId - Route table ID to process
   * @param routeTableName - Route table name for response building
   * @param tgwName - Transit gateway name for response building
   * @param region - Region for response building
   * @param desired - Desired associations from config
   * @param knownAttachmentIds - Set of all managed attachment IDs
   * @param dryRun - Whether to perform dry run without making changes
   * @param logPrefix - Prefix for logging messages
   * @returns Promise resolving to association operation results
   */
  public static async process(
    ec2: EC2Client,
    routeTableId: string,
    routeTableName: string,
    tgwName: string,
    region: string,
    desired: IDesiredAttachment[],
    knownAttachmentIds: Set<string>,
    dryRun: boolean,
    logPrefix: string,
  ): Promise<ITgwAssociationResponse[]> {
    const results: ITgwAssociationResponse[] = [];

    const transitionalStates = ['associating', 'disassociating'];
    let current = await this.getCurrent(ec2, routeTableId, logPrefix);

    if (current.some(a => transitionalStates.includes(a.State!))) {
      logger.info(
        `Route table ${routeTableName} has associations in transitional state, waiting for stable state...`,
        logPrefix,
      );
      await waitUntil(async () => {
        const latest = await this.getCurrent(ec2, routeTableId, logPrefix);
        return !latest.some(a => transitionalStates.includes(a.State!));
      }, `Associations on route table ${routeTableName} did not reach stable state within timeout`);
      current = await this.getCurrent(ec2, routeTableId, logPrefix);
    }

    // Filter out disassociated items — they are terminal and should not block toCreate
    current = current.filter(a => a.State !== 'disassociated');

    const desiredMap = new Map(desired.map(d => [d.attachmentId, d]));
    const currentSet = new Set(current.map(a => a.TransitGatewayAttachmentId!));

    const toCreate = desired.filter(d => !currentSet.has(d.attachmentId));
    const toDelete = current.filter(
      a =>
        knownAttachmentIds.has(a.TransitGatewayAttachmentId!) &&
        !desiredMap.has(a.TransitGatewayAttachmentId!) &&
        a.State === 'associated',
    );
    const existing = desired.filter(d => currentSet.has(d.attachmentId));

    for (const item of existing) {
      results.push(this.buildResponse('exists', region, tgwName, routeTableName, item));
    }

    // Disassociate first (respect 1:1 constraint)
    for (const assoc of toDelete) {
      const attachmentId = assoc.TransitGatewayAttachmentId!;
      const attachmentName = findAttachmentName(attachmentId, desired);
      const parameters = { TransitGatewayRouteTableId: routeTableId, TransitGatewayAttachmentId: attachmentId };

      if (dryRun) {
        logger.dryRun('DisassociateTransitGatewayRouteTableCommand', parameters, logPrefix);
        results.push(
          this.buildResponse('deleted', region, tgwName, routeTableName, {
            attachmentId,
            attachmentName,
            attachmentType: 'vpc',
          }),
        );
        continue;
      }

      try {
        await executeApi(
          'DisassociateTransitGatewayRouteTableCommand',
          parameters,
          () => ec2.send(new DisassociateTransitGatewayRouteTableCommand(parameters)),
          logger,
          logPrefix,
        );
      } catch (e: unknown) {
        if (e instanceof Error && (e.name === 'InvalidAssociation.NotFound' || e.name === 'Resource.NotFound')) {
          logger.warn(`Association already removed for ${attachmentName} on ${routeTableName}`, logPrefix);
        } else {
          throw e;
        }
      }
      results.push(
        this.buildResponse('deleted', region, tgwName, routeTableName, {
          attachmentId,
          attachmentName,
          attachmentType: 'vpc',
        }),
      );
    }

    // Create new associations
    for (const item of toCreate) {
      const parameters = { TransitGatewayRouteTableId: routeTableId, TransitGatewayAttachmentId: item.attachmentId };

      if (dryRun) {
        logger.dryRun('AssociateTransitGatewayRouteTableCommand', parameters, logPrefix);
        results.push(this.buildResponse('created', region, tgwName, routeTableName, item));
        continue;
      }

      try {
        await executeApi(
          'AssociateTransitGatewayRouteTableCommand',
          parameters,
          () => ec2.send(new AssociateTransitGatewayRouteTableCommand(parameters)),
          logger,
          logPrefix,
        );
        results.push(this.buildResponse('created', region, tgwName, routeTableName, item));
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'Resource.AlreadyAssociated') {
          // The attachment is already associated -- but possibly to a DIFFERENT route table
          // (an association MOVE). An attachment can only be associated to one route table at a
          // time, so EC2 returns Resource.AlreadyAssociated whether the existing association is on
          // THIS route table or another one. We must distinguish the two:
          //   - associated to THIS route table  -> idempotent no-op, treat as exists
          //   - associated to a DIFFERENT table  -> move: disassociate from the old table, wait for
          //     it to clear, then associate here. Without this, the old table's pass later
          //     disassociates the attachment and it is left associated to NO route table while the
          //     pipeline reports success.
          const currentAssociation = await this.getAttachmentAssociation(ec2, item.attachmentId, logPrefix);
          const currentRouteTableId =
            currentAssociation?.State === 'associated' ? currentAssociation.TransitGatewayRouteTableId : undefined;

          if (currentRouteTableId === undefined || currentRouteTableId === routeTableId) {
            logger.info(
              `Association already exists for ${item.attachmentName} → ${routeTableName}, treating as exists`,
              logPrefix,
            );
            results.push(this.buildResponse('exists', region, tgwName, routeTableName, item));
          } else {
            logger.info(
              `${item.attachmentName} is associated to ${currentRouteTableId}; moving to ${routeTableName}`,
              logPrefix,
            );
            const moveParameters = {
              TransitGatewayRouteTableId: currentRouteTableId,
              TransitGatewayAttachmentId: item.attachmentId,
            };
            await executeApi(
              'DisassociateTransitGatewayRouteTableCommand',
              moveParameters,
              () => ec2.send(new DisassociateTransitGatewayRouteTableCommand(moveParameters)),
              logger,
              logPrefix,
            );
            // Wait until the attachment is fully clear of the old route table (association gone or
            // 'disassociated') before re-associating -- an attachment cannot associate while it is
            // still in 'associated' or 'disassociating' state on another route table.
            await waitUntil(async () => {
              const a = await this.getAttachmentAssociation(ec2, item.attachmentId, logPrefix);
              return a === undefined || a.State === 'disassociated';
            }, `Attachment ${item.attachmentName} did not disassociate from ${currentRouteTableId} within timeout`);
            await executeApi(
              'AssociateTransitGatewayRouteTableCommand',
              parameters,
              () => ec2.send(new AssociateTransitGatewayRouteTableCommand(parameters)),
              logger,
              logPrefix,
            );
            results.push(this.buildResponse('created', region, tgwName, routeTableName, item));
          }
        } else {
          throw e;
        }
      }
    }

    return results;
  }

  /**
   * Queries current associations for a route table with pagination
   * @param ec2 - EC2 client instance
   * @param routeTableId - Route table ID to query
   * @param logPrefix - Prefix for logging messages
   * @returns Promise resolving to current associations
   */
  private static async getCurrent(
    ec2: EC2Client,
    routeTableId: string,
    logPrefix: string,
  ): Promise<TransitGatewayRouteTableAssociation[]> {
    const results: TransitGatewayRouteTableAssociation[] = [];
    let nextToken: string | undefined;
    do {
      const response = await executeApi(
        'GetTransitGatewayRouteTableAssociationsCommand',
        { TransitGatewayRouteTableId: routeTableId },
        () =>
          ec2.send(
            new GetTransitGatewayRouteTableAssociationsCommand({
              TransitGatewayRouteTableId: routeTableId,
              NextToken: nextToken,
            }),
          ),
        logger,
        logPrefix,
      );
      results.push(...(response.Associations ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return results;
  }

  /**
   * Returns the attachment's current route table association (or undefined if none), used to
   * detect and complete association MOVES. EC2 returns Resource.AlreadyAssociated on associate
   * regardless of which route table the attachment is currently on, so we describe the attachment
   * to learn the actual association and its state.
   * @param ec2 - EC2 client instance
   * @param attachmentId - Transit gateway attachment ID
   * @param logPrefix - Prefix for logging messages
   * @returns The attachment's Association, or undefined if it has none
   */
  private static async getAttachmentAssociation(
    ec2: EC2Client,
    attachmentId: string,
    logPrefix: string,
  ): Promise<TransitGatewayAttachmentAssociation | undefined> {
    const response = await executeApi(
      'DescribeTransitGatewayAttachmentsCommand',
      { TransitGatewayAttachmentIds: [attachmentId] },
      () => ec2.send(new DescribeTransitGatewayAttachmentsCommand({ TransitGatewayAttachmentIds: [attachmentId] })),
      logger,
      logPrefix,
    );
    return response.TransitGatewayAttachments?.[0]?.Association;
  }

  /**
   * Builds a typed association response
   */
  private static buildResponse(
    operation: TgwOperationResult,
    region: string,
    tgwName: string,
    routeTableName: string,
    attachment: IDesiredAttachment,
  ): ITgwAssociationResponse {
    return {
      operation,
      region,
      tgwName,
      routeTableName,
      attachmentType: attachment.attachmentType,
      attachmentName: attachment.attachmentName,
    };
  }
}
