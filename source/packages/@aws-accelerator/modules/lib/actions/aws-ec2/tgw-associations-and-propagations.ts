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

import path from 'path';
import {
  configureTgw,
  createStatusLogger,
  ITgwAttachmentConfig,
  ITgwModuleRequest,
} from '../../../../../@aws-lza/index';
import { ModuleParams } from '../../../models/types';

const statusLogger = createStatusLogger([path.parse(path.basename(__filename)).name]);

/**
 * LZA Action adapter for Transit Gateway associations and propagations.
 * Reads LZA config, builds ITgwModuleRequest, delegates to configureTgw().
 */
export abstract class TgwAssociationsAndPropagationsModule {
  public static async execute(params: ModuleParams): Promise<string> {
    const logPrefix = `${params.runnerParameters.region}`;

    const { networkConfig, accountsConfig, globalConfig } = params.moduleRunnerParameters.configs;

    // Early exit if no transit gateways configured
    if (!networkConfig.transitGateways || networkConfig.transitGateways.length === 0) {
      const message = `Skipping module ${params.moduleItem.name} — no transit gateways configured.`;
      statusLogger.info(message, logPrefix);
      return message;
    }

    // Build TGW configs
    const tgwConfigs = (networkConfig.transitGateways ?? []).map(tgw => ({
      name: tgw.name,
      accountId: accountsConfig.getAccountId(tgw.account),
      region: tgw.region,
      routeTables: (tgw.routeTables ?? []).map(rt => ({ name: rt.name })),
    }));

    const tgwNames = new Set(tgwConfigs.map(t => t.name));

    // Build VPC attachments
    const attachments: ITgwAttachmentConfig[] = [];
    const allVpcs = [...(networkConfig.vpcs ?? []), ...(networkConfig.vpcTemplates ?? [])];

    for (const vpc of allVpcs) {
      for (const tgwAtt of vpc.transitGatewayAttachments ?? []) {
        if (!tgwNames.has(tgwAtt.transitGateway.name)) continue;

        const accountIds =
          'account' in vpc
            ? [accountsConfig.getAccountId(vpc.account)]
            : accountsConfig.getAccountIdsFromDeploymentTarget(vpc.deploymentTargets);

        for (const accountId of accountIds) {
          attachments.push({
            type: 'vpc',
            name: vpc.name,
            attachmentName: tgwAtt.name,
            accountId,
            transitGateway: tgwAtt.transitGateway.name,
            routeTableAssociations: tgwAtt.routeTableAssociations ?? [],
            routeTablePropagations: tgwAtt.routeTablePropagations ?? [],
          });
        }
      }
    }

    // Build VPN attachments
    for (const cgw of networkConfig.customerGateways ?? []) {
      for (const vpn of cgw.vpnConnections ?? []) {
        if (vpn.transitGateway && tgwNames.has(vpn.transitGateway)) {
          attachments.push({
            type: 'vpn',
            name: vpn.name,
            accountId: accountsConfig.getAccountId(cgw.account),
            transitGateway: vpn.transitGateway,
            routeTableAssociations: vpn.routeTableAssociations ?? [],
            routeTablePropagations: vpn.routeTablePropagations ?? [],
          });
        }
      }
    }

    const request: ITgwModuleRequest = {
      partition: params.runnerParameters.partition,
      region: params.runnerParameters.region,
      globalRegion: params.moduleRunnerParameters.globalRegion,
      invokingAccountId: accountsConfig.getManagementAccountId(),
      operation: 'setup',
      moduleName: params.moduleItem.name,
      solutionId: params.runnerParameters.solutionId,
      credentials: params.moduleRunnerParameters.managementAccountCredentials,
      dryRun: params.runnerParameters.dryRun,
      configuration: {
        enable: true,
        accountAccessRoleName: globalConfig.managementAccountAccessRole,
        transitGateways: tgwConfigs,
        attachments,
        dataSources: {
          ssmParameterPrefix: params.moduleRunnerParameters.resourcePrefixes.ssmParamName,
        },
        boundary: { regions: globalConfig.enabledRegions },
      },
    };

    statusLogger.info('Executing TGW module', logPrefix);
    const result = await configureTgw(request);

    statusLogger.info(`TGW module completed with status: ${result.status}`, logPrefix);
    return result.summary;
  }
}
