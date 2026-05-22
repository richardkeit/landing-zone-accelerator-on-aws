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
 * @fileoverview TGW Connect attachment management for the TGW module.
 *
 * Creates or discovers TGW Connect attachments via SDK. Connect attachments
 * use an existing VPC or DX Gateway attachment as their transport layer and
 * enable GRE tunnels with BGP for SD-WAN appliance connectivity.
 *
 * Discovery strategy: DescribeTransitGatewayConnects filtered by
 * transport-transit-gateway-attachment-id, matched by Name tag.
 *
 * Ownership model: The module tags every Connect it creates with
 * `accelerator:module = tgw-associations-and-propagations`. Deletion only
 * operates on Connects carrying this tag, so out-of-band Connects (created
 * via Console, CLI, or other IaC) are never removed. Connects matched by
 * Name tag during discovery are adopted: the ownership tag is added so
 * the module can manage their lifecycle going forward. This preserves the
 * CDK-to-module upgrade path.
 */

import {
  CreateTagsCommand,
  CreateTransitGatewayConnectCommand,
  DeleteTransitGatewayConnectCommand,
  DescribeTransitGatewayConnectsCommand,
  EC2Client,
  TransitGatewayConnect as AwsTgwConnect,
} from '@aws-sdk/client-ec2';
import path from 'node:path';
import { createLogger } from '../common/logger';
import { getCredentials } from '../common/sts-functions';
import { executeApi, setRetryStrategy } from '../common/utility';
import { ITgwConnectConfig, ITgwConnectResponse, ITgwModuleRequest, ITgwResolvedContext } from './interfaces';

const logger = createLogger([path.parse(path.basename(__filename)).name]);

const CONNECT_POLL_INTERVAL_MS = 10_000; // 10 s per poll
const CONNECT_MAX_POLL_RETRIES = 36; // 6 min max — covers GovCloud, fresh TGWs, and throttled accounts

/**
 * Ownership tag applied to every Connect attachment this module creates.
 * Only Connects carrying this tag are eligible for stale-deletion. Connects
 * missing the tag are treated as out-of-band and left untouched.
 */
const MODULE_MANAGED_BY_TAG_KEY = 'accelerator:module';
const MODULE_MANAGED_BY_TAG_VALUE = 'tgw-associations-and-propagations';

interface IFoundConnect {
  readonly attachmentId: string;
  readonly isModuleManaged: boolean;
}

/**
 * TGW Connect attachment management for the TGW module.
 */
export abstract class TransitGatewayConnect {
  /**
   * Creates or discovers TGW Connect attachments.
   * Runs after Phase 1 (attachment resolution) so transport attachment IDs are available.
   *
   * Adopt-on-sight: when an existing Connect is matched by Name but lacks the ownership
   * tag, the module tags it so future runs can manage it. This is how CDK-created
   * Connects get migrated to module management on first run.
   */
  public static async createConnectAttachments(
    props: ITgwModuleRequest,
    resolvedContext: ITgwResolvedContext,
    logPrefix: string,
  ): Promise<ITgwConnectResponse[]> {
    const connectConfigs = props.configuration.connectAttachments ?? [];
    if (connectConfigs.length === 0) return [];

    const dryRun = props.dryRun ?? false;
    const responses: ITgwConnectResponse[] = [];
    // Cache EC2 clients per (accountId, region) for the duration of this call. Avoids N
    // sts:AssumeRole calls when a customer has N Connects on the same cross-account TGW.
    const ec2ClientCache = new Map<string, EC2Client>();

    for (const connectItem of connectConfigs) {
      const tgwConfig = props.configuration.transitGateways.find(t => t.name === connectItem.transitGateway);
      if (!tgwConfig) {
        throw new Error(`TGW '${connectItem.transitGateway}' not found for Connect '${connectItem.name}'`);
      }

      // Resolve transport attachment ID from context
      const transportKey = TransitGatewayConnect.buildTransportKey(connectItem);
      const transportAttachmentId = resolvedContext.attachmentIds.get(transportKey);
      if (!transportAttachmentId) {
        throw new Error(
          `Transport attachment '${transportKey}' not found for Connect '${connectItem.name}'. ` +
            `Ensure the transport VPC or DX Gateway attachment is configured.`,
        );
      }

      const ec2Client = await TransitGatewayConnect.getOrBuildEc2Client(
        ec2ClientCache,
        props,
        tgwConfig.accountId,
        tgwConfig.region,
      );

      // Check if Connect already exists
      const existing = await TransitGatewayConnect.findExistingConnect(
        ec2Client,
        transportAttachmentId,
        connectItem.name,
        logPrefix,
      );

      if (existing) {
        // Adopt-on-sight: if the Connect is not yet module-managed, tag it so we can manage it.
        // Skipped in dry-run to avoid writes.
        if (!existing.isModuleManaged && !dryRun) {
          await TransitGatewayConnect.adoptConnect(ec2Client, existing.attachmentId, connectItem.name, logPrefix);
        }
        logger.info(`Connect '${connectItem.name}' already exists: ${existing.attachmentId}`, logPrefix);
        responses.push({
          operation: 'exists',
          region: tgwConfig.region,
          tgwName: connectItem.transitGateway,
          connectName: connectItem.name,
          connectAttachmentId: existing.attachmentId,
        });
        continue;
      }

      if (dryRun) {
        logger.info(
          `[DRY RUN] Would create Connect '${connectItem.name}' on transport ${transportAttachmentId}`,
          logPrefix,
        );
        responses.push({
          operation: 'skipped',
          region: tgwConfig.region,
          tgwName: connectItem.transitGateway,
          connectName: connectItem.name,
          connectAttachmentId: '',
        });
        continue;
      }

      // Create Connect attachment
      const connectAttachmentId = await TransitGatewayConnect.createConnect(
        ec2Client,
        transportAttachmentId,
        connectItem,
        logPrefix,
      );

      responses.push({
        operation: 'created',
        region: tgwConfig.region,
        tgwName: connectItem.transitGateway,
        connectName: connectItem.name,
        connectAttachmentId,
      });
    }

    return responses;
  }

  /**
   * Deletes Connect attachments that this module created but that are no longer declared in config.
   * Only operates on Connects carrying the module ownership tag — out-of-band Connects are skipped.
   * Compares live state (DescribeTransitGatewayConnects) against desired config.
   */
  public static async deleteStaleConnectAttachments(
    props: ITgwModuleRequest,
    resolvedContext: ITgwResolvedContext,
    logPrefix: string,
  ): Promise<ITgwConnectResponse[]> {
    const connectConfigs = props.configuration.connectAttachments ?? [];
    const dryRun = props.dryRun ?? false;
    const responses: ITgwConnectResponse[] = [];
    // Cache EC2 clients per (accountId, region) — avoids repeated sts:AssumeRole when scanning
    // multiple managed TGWs in the same account/region.
    const ec2ClientCache = new Map<string, EC2Client>();

    // Build set of declared Connect names per TGW
    const declaredNames = new Set(connectConfigs.map(c => `${c.transitGateway}::${c.name}`));

    // Scan each managed TGW for Connect attachments
    for (const tgwConfig of props.configuration.transitGateways) {
      const tgwId = resolvedContext.transitGatewayIds.get(tgwConfig.name);
      if (!tgwId) continue;

      const ec2Client = await TransitGatewayConnect.getOrBuildEc2Client(
        ec2ClientCache,
        props,
        tgwConfig.accountId,
        tgwConfig.region,
      );

      const connects = await TransitGatewayConnect.describeAllConnects(
        ec2Client,
        [
          { Name: 'transit-gateway-id', Values: [tgwId] },
          { Name: 'state', Values: ['available'] },
        ],
        logPrefix,
      );

      for (const connect of connects) {
        const nameTag = connect.Tags?.find(t => t.Key === 'Name')?.Value;
        if (!nameTag) continue;

        // Skip if declared in config
        if (declaredNames.has(`${tgwConfig.name}::${nameTag}`)) continue;

        // Skip if NOT module-managed — out-of-band Connects are off-limits
        const isModuleManaged = connect.Tags?.some(
          t => t.Key === MODULE_MANAGED_BY_TAG_KEY && t.Value === MODULE_MANAGED_BY_TAG_VALUE,
        );
        if (!isModuleManaged) {
          logger.info(
            `Skipping Connect '${nameTag}' (${connect.TransitGatewayAttachmentId}) — not managed by this module ` +
              `(missing '${MODULE_MANAGED_BY_TAG_KEY}=${MODULE_MANAGED_BY_TAG_VALUE}' tag)`,
            logPrefix,
          );
          continue;
        }

        const attachmentId = connect.TransitGatewayAttachmentId;
        if (!attachmentId) continue;

        if (dryRun) {
          logger.info(`[DRY RUN] Would delete stale Connect '${nameTag}' (${attachmentId})`, logPrefix);
          responses.push({
            operation: 'deleted',
            region: tgwConfig.region,
            tgwName: tgwConfig.name,
            connectName: nameTag,
            connectAttachmentId: attachmentId,
          });
          continue;
        }

        logger.info(`Deleting stale Connect '${nameTag}' (${attachmentId})`, logPrefix);

        await executeApi(
          'DeleteTransitGatewayConnectCommand',
          { transitGatewayAttachmentId: attachmentId },
          () =>
            ec2Client.send(
              new DeleteTransitGatewayConnectCommand({
                TransitGatewayAttachmentId: attachmentId,
              }),
            ),
          logger,
          logPrefix,
        );

        responses.push({
          operation: 'deleted',
          region: tgwConfig.region,
          tgwName: tgwConfig.name,
          connectName: nameTag,
          connectAttachmentId: attachmentId,
        });
      }
    }

    return responses;
  }

  /**
   * Builds the transport attachment key matching the resolved context map.
   * - VPC transport key format: `${tgwName}_${vpcAccountId}_${vpcName}`
   * - DX  transport key format: `${tgwName}_${dxGatewayAccountId}_dxgw-${dxGatewayName}`
   *   (matches what DirectConnectGatewayAssociation.resolveDxGatewayAssociations writes)
   */
  private static buildTransportKey(config: ITgwConnectConfig): string {
    if (config.transportAttachmentType === 'vpc') {
      return `${config.transitGateway}_${config.transportAccountId}_${config.transportName}`;
    }
    return `${config.transitGateway}_${config.transportAccountId}_dxgw-${config.transportName}`;
  }

  /**
   * Paginated helper: describes all Connect attachments matching the given filters,
   * following NextToken until exhausted.
   */
  private static async describeAllConnects(
    ec2Client: EC2Client,
    filters: { Name: string; Values: string[] }[],
    logPrefix: string,
  ): Promise<AwsTgwConnect[]> {
    const all: AwsTgwConnect[] = [];
    let nextToken: string | undefined;
    do {
      const response = await executeApi(
        'DescribeTransitGatewayConnectsCommand',
        { filters },
        () =>
          ec2Client.send(
            new DescribeTransitGatewayConnectsCommand({
              Filters: filters,
              NextToken: nextToken,
            }),
          ),
        logger,
        logPrefix,
      );
      all.push(...(response.TransitGatewayConnects ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return all;
  }

  /**
   * Discovers an existing Connect attachment by transport attachment ID and Name tag.
   * Returns both the attachment ID and whether it already carries the module ownership tag.
   */
  private static async findExistingConnect(
    ec2Client: EC2Client,
    transportAttachmentId: string,
    connectName: string,
    logPrefix: string,
  ): Promise<IFoundConnect | undefined> {
    const connects = await TransitGatewayConnect.describeAllConnects(
      ec2Client,
      [
        { Name: 'transport-transit-gateway-attachment-id', Values: [transportAttachmentId] },
        { Name: 'state', Values: ['available', 'pending', 'modifying'] },
      ],
      logPrefix,
    );

    for (const connect of connects) {
      const nameTag = connect.Tags?.find(t => t.Key === 'Name')?.Value;
      if (nameTag !== connectName || !connect.TransitGatewayAttachmentId) continue;

      const isModuleManaged =
        connect.Tags?.some(t => t.Key === MODULE_MANAGED_BY_TAG_KEY && t.Value === MODULE_MANAGED_BY_TAG_VALUE) ??
        false;
      return { attachmentId: connect.TransitGatewayAttachmentId, isModuleManaged };
    }

    return undefined;
  }

  /**
   * Adds the module ownership tag to an existing Connect attachment.
   * Used by adopt-on-sight for Connects that match by Name but predate module management
   * (e.g. CDK-created Connects on upgrade). Failures are logged as warnings, not thrown —
   * the caller continues; the un-adopted Connect will be skipped by stale-deletion checks.
   */
  private static async adoptConnect(
    ec2Client: EC2Client,
    attachmentId: string,
    connectName: string,
    logPrefix: string,
  ): Promise<void> {
    try {
      await executeApi(
        'CreateTagsCommand',
        { resources: [attachmentId] },
        () =>
          ec2Client.send(
            new CreateTagsCommand({
              Resources: [attachmentId],
              Tags: [{ Key: MODULE_MANAGED_BY_TAG_KEY, Value: MODULE_MANAGED_BY_TAG_VALUE }],
            }),
          ),
        logger,
        logPrefix,
      );
      logger.info(`Adopted Connect '${connectName}' (${attachmentId}) — added module ownership tag`, logPrefix);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      logger.warn(
        `Failed to adopt Connect '${connectName}' (${attachmentId}): ${msg}. ` +
          `Continuing without ownership tag — this Connect will be skipped during stale-deletion checks.`,
        logPrefix,
      );
    }
  }

  /**
   * Creates a TGW Connect attachment with atomic tagging via TagSpecifications, then waits
   * for it to become available. Tagging is atomic with creation so there is no window in
   * which an untagged orphan attachment could exist.
   */
  private static async createConnect(
    ec2Client: EC2Client,
    transportAttachmentId: string,
    config: ITgwConnectConfig,
    logPrefix: string,
  ): Promise<string> {
    logger.info(`Creating Connect '${config.name}' on transport ${transportAttachmentId}`, logPrefix);

    // Drop any user-supplied tag that would collide with module-controlled tags (Name and the
    // ownership tag). Module tags are appended LAST as an additional safeguard — EC2 TagSpecifications
    // uses the last occurrence of a duplicate key, so this guarantees module-controlled values win
    // even if the filter is somehow bypassed in the future.
    const reservedTagKeys = new Set<string>(['Name', MODULE_MANAGED_BY_TAG_KEY]);
    const userTags = (config.tags ?? [])
      .filter(t => !reservedTagKeys.has(t.key))
      .map(t => ({ Key: t.key, Value: t.value }));
    const tags = [
      ...userTags,
      { Key: 'Name', Value: config.name },
      { Key: MODULE_MANAGED_BY_TAG_KEY, Value: MODULE_MANAGED_BY_TAG_VALUE },
    ];

    let createResponse;
    try {
      createResponse = await executeApi(
        'CreateTransitGatewayConnectCommand',
        { transportAttachmentId, protocol: config.options.protocol },
        () =>
          ec2Client.send(
            new CreateTransitGatewayConnectCommand({
              TransportTransitGatewayAttachmentId: transportAttachmentId,
              Options: { Protocol: config.options.protocol },
              TagSpecifications: [
                {
                  ResourceType: 'transit-gateway-attachment',
                  Tags: tags,
                },
              ],
            }),
          ),
        logger,
        logPrefix,
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'DuplicateTransitGatewayAttachment') {
        logger.info(`Connect '${config.name}' already exists (concurrent creation). Discovering...`, logPrefix);
        // Note: do NOT adopt in the duplicate-retry path. A concurrent execution may have
        // created the Connect, and we shouldn't attribute it to this run's ownership.
        const existing = await TransitGatewayConnect.findExistingConnect(
          ec2Client,
          transportAttachmentId,
          config.name,
          logPrefix,
        );
        if (existing) return existing.attachmentId;
        throw new Error(`Connect '${config.name}' reported as duplicate but not found on re-query`);
      }
      throw e;
    }

    const connectAttachmentId = createResponse.TransitGatewayConnect?.TransitGatewayAttachmentId;
    if (!connectAttachmentId) {
      throw new Error(`CreateTransitGatewayConnect returned no attachment ID for '${config.name}'`);
    }

    // Poll until available
    await TransitGatewayConnect.pollConnectState(ec2Client, connectAttachmentId, logPrefix);

    logger.info(`Connect '${config.name}' created: ${connectAttachmentId}`, logPrefix);
    return connectAttachmentId;
  }

  /**
   * Polls a Connect attachment until it reaches 'available' state.
   */
  private static async pollConnectState(
    ec2Client: EC2Client,
    connectAttachmentId: string,
    logPrefix: string,
  ): Promise<void> {
    for (let i = 0; i < CONNECT_MAX_POLL_RETRIES; i++) {
      const response = await executeApi(
        'DescribeTransitGatewayConnectsCommand',
        { connectAttachmentId },
        () =>
          ec2Client.send(
            new DescribeTransitGatewayConnectsCommand({
              TransitGatewayAttachmentIds: [connectAttachmentId],
            }),
          ),
        logger,
        logPrefix,
      );

      const state = response.TransitGatewayConnects?.[0]?.State;
      if (state === 'available') return;
      if (state === 'failed' || state === 'deleted' || state === 'deleting') {
        throw new Error(`Connect ${connectAttachmentId} entered terminal state: ${state}`);
      }

      logger.info(`Connect ${connectAttachmentId} state: ${state}, polling...`, logPrefix);
      await new Promise(resolve => setTimeout(resolve, CONNECT_POLL_INTERVAL_MS));
    }

    throw new Error(
      `Connect ${connectAttachmentId} did not reach 'available' after ${CONNECT_MAX_POLL_RETRIES} retries`,
    );
  }

  /**
   * Returns an EC2 client for the target account/region from cache, building it on first use.
   * Shared cache across a single top-level call avoids duplicate `sts:AssumeRole` invocations
   * when multiple Connects live on the same (accountId, region).
   */
  private static async getOrBuildEc2Client(
    cache: Map<string, EC2Client>,
    props: ITgwModuleRequest,
    accountId: string,
    region: string,
  ): Promise<EC2Client> {
    const key = `${accountId}_${region}`;
    let client = cache.get(key);
    if (!client) {
      client = await TransitGatewayConnect.buildEc2Client(props, accountId, region);
      cache.set(key, client);
    }
    return client;
  }

  /**
   * Builds an EC2 client for the target account/region.
   */
  private static async buildEc2Client(props: ITgwModuleRequest, accountId: string, region: string): Promise<EC2Client> {
    if (accountId === props.invokingAccountId) {
      return new EC2Client({
        region,
        customUserAgent: props.solutionId,
        retryStrategy: setRetryStrategy(),
        credentials: props.credentials,
      });
    }

    const credentials = await getCredentials({
      partition: props.partition,
      accountId,
      region,
      logPrefix: `${props.invokingAccountId}:${props.region}`,
      solutionId: props.solutionId,
      assumeRoleName: props.configuration.accountAccessRoleName,
      credentials: props.credentials,
    });

    return new EC2Client({
      region,
      customUserAgent: props.solutionId,
      retryStrategy: setRetryStrategy(),
      credentials: credentials ?? props.credentials,
    });
  }
}
