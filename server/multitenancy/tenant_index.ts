/*
 *   Copyright OpenSearch Contributors
 *
 *   Licensed under the Apache License, Version 2.0 (the "License").
 *   You may not use this file except in compliance with the License.
 *   A copy of the License is located at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   or in the "license" file accompanying this file. This file is distributed
 *   on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 *   express or implied. See the License for the specific language governing
 *   permissions and limitations under the License.
 */

import {
  OpenSearchClient,
  ISavedObjectTypeRegistry,
  Logger,
  SavedObjectsSerializer,
} from '../../../../src/core/server';
import { IndexMapping, SavedObjectsTypeMappingDefinitions } from '../../../../src/core/server/saved_objects/mappings';
import {
  buildActiveMappings,
  DocumentMigrator,
  IndexMigrator,
  MigrationOpenSearchClient,
} from '../../../../src/core/server/saved_objects/migrations/core';
import { createIndexMap } from '../../../../src/core/server/saved_objects/migrations/core/build_index_map';
import { mergeTypes } from '../../../../src/core/server/saved_objects/migrations/opensearch_dashboards/opensearch_dashboards_migrator';
import { SecurityClient } from '../backend/opensearch_security_client';
import * as Index from '../../../../src/core/server/saved_objects/migrations/core/opensearch_index';
import { Context, disableUnknownTypeMappingFields } from '../../../../src/core/server/saved_objects/migrations/core/migration_context';
import { MigrationLogger } from '../../../../src/core/server/saved_objects/migrations/core/migration_logger';
import { migrateRawDocs } from '../../../../src/core/server/saved_objects/migrations/core/migrate_raw_docs';

export async function setupIndexTemplate(
  esClient: OpenSearchClient,
  opensearchDashboardsIndex: string,
  typeRegistry: ISavedObjectTypeRegistry,
  logger: Logger
) {
  const mappings: IndexMapping = buildActiveMappings(mergeTypes(typeRegistry.getAllTypes()));
  try {
    await esClient.indices.putTemplate({
      name: 'tenant_template',
      body: {
        index_patterns: [
          opensearchDashboardsIndex + '_-*_*',
          opensearchDashboardsIndex + '_0*_*',
          opensearchDashboardsIndex + '_1*_*',
          opensearchDashboardsIndex + '_2*_*',
          opensearchDashboardsIndex + '_3*_*',
          opensearchDashboardsIndex + '_4*_*',
          opensearchDashboardsIndex + '_5*_*',
          opensearchDashboardsIndex + '_6*_*',
          opensearchDashboardsIndex + '_7*_*',
          opensearchDashboardsIndex + '_8*_*',
          opensearchDashboardsIndex + '_9*_*',
        ],
        settings: {
          number_of_shards: 1,
        },
        mappings,
      },
    });
  } catch (error: any) {
    logger.error(error);
    throw error;
  }
}

export async function migrateTenantIndices(
  opensearchDashboardsVersion: string,
  migrationClient: MigrationOpenSearchClient,
  securityClient: SecurityClient,
  typeRegistry: ISavedObjectTypeRegistry,
  serializer: SavedObjectsSerializer,
  logger: Logger
) {
  let tenentInfo: any;
  try {
    tenentInfo = await securityClient.getTenantInfoWithInternalUser();
    console.log(JSON.stringify(tenentInfo));
  } catch (error: any) {
    logger.error(error);
    throw error;
  }

  // follows the same approach in opensearch_dashboards_migrator.ts to initiate DocumentMigrator here
  // see: https://tiny.amazon.com/foi0x1wt/githelaskibablobe4c1srccore
  const documentMigrator = new DocumentMigrator({
    opensearchDashboardsVersion,
    typeRegistry,
    log: logger,
  });

  for (const indexName of Object.keys(tenentInfo)) {
    const indexMap = createIndexMap({
      opensearchDashboardsIndexName: indexName,
      indexMap: mergeTypes(typeRegistry.getAllTypes()),
      registry: typeRegistry,
    });

    // follows the same aporach in opensearch_dashboards_mirator.ts to construct IndexMigrator
    // see: https://tiny.amazon.com/9cdcchz5/githelaskibablobe4c1srccore
    //
    // FIXME: hard code batchSize, pollInterval, and scrollDuration for now
    //        they are used to fetched from `migration.xxx` config, which is not accessible from new playform
    // const indexMigrator = new IndexMigrator({
    //   batchSize: 100,
    //   client: migrationClient,
    //   documentMigrator,
    //   index: indexName,
    //   log: logger,
    //   mappingProperties: indexMap[indexName].typeMappings,
    //   pollInterval: 1500, // millisec
    //   scrollDuration: '15m',
    //   serializer,
    //   obsoleteIndexTemplatePattern: undefined,
    //   convertToAliasScript: indexMap[indexName].script,
    // });
    // try {
    //   await indexMigrator.migrate();
    // } catch (error: any) {
    //   logger.error(error);
    //   // fail early, exit the kibana process
    //   // NOTE: according to https://github.com/elastic/kibana/issues/41983 ,
    //   //       PR https://github.com/elastic/kibana/pull/75819 , API to allow plugins
    //   //       to set status will be available in 7.10, for now, we fail OpenSearchDashboards
    //   //       process to indicate index migration error. Customer can fix their
    //   //       tenant indices in ES then restart OpenSearchDashboards.
    //   process.exit(1);
    // }

    // const { log, client } = opts;
    // const alias = opts.index;
    // const source = createSourceContext(await Index.fetchInfo(client, alias), alias);
    // const dest = createDestContext(source, alias, opts.mappingProperties);

    try {
      const source = createSourceContext(await Index.fetchInfo(migrationClient, indexName), indexName);
      const dest = createDestContext(await Index.fetchInfo(migrationClient, '.kibana'), '.kibana' ,indexMap[indexName].typeMappings);
      const context: Context = {
        client: migrationClient,
        alias: indexName,
        source,
        dest,
        documentMigrator: documentMigrator,
        log: new MigrationLogger(logger),
        batchSize: 100,
        pollInterval: 2500,
        scrollDuration: '5m',
        serializer,
        obsoleteIndexTemplatePattern: undefined,
        convertToAliasScript: indexMap[indexName].script,
      };
      // console.log(JSON.stringify(context));
      // console.log('-------------');
      console.log(dest.indexName);
      await migrateSourceToDest(context);
      await Index.claimAlias(migrationClient, dest.indexName, '.kibana');
    } catch (error: any) {
      logger.error(error);
      throw error;
    }
  }
}

async function migrateSourceToDest(context: Context) {
  const { client, alias, dest, source, batchSize } = context;
  const { scrollDuration, documentMigrator, log, serializer } = context;

  if (!source.exists) {
    return;
  }

  if (!source.aliases[alias]) {
    log.info(`Reindexing ${alias} to ${source.indexName}`);

    await Index.convertToAlias(client, source, alias, batchSize, context.convertToAliasScript);
  }

  const read = Index.reader(client, source.indexName, { batchSize, scrollDuration });

  log.info(`Migrating ${source.indexName} saved objects to ${dest.indexName}`);

  while (true) {
    const docs = await read();

    if (!docs || !docs.length) {
      return;
    }

    log.debug(`Migrating saved objects ${docs.map((d) => d._id).join(', ')}`);

    await Index.write(
      client,
      dest.indexName,
      // @ts-expect-error @opensearch-project/opensearch _source is optional
      await migrateRawDocs(serializer, documentMigrator.migrate, docs, log)
    );
  }
}

function createSourceContext(source: Index.FullIndexInfo, alias: string) {
  if (source.exists && source.indexName === alias) {
    return {
      ...source,
      indexName: nextIndexName(alias, alias),
    };
  }

  return source;
}

function createDestContext(
  source: Index.FullIndexInfo,
  alias: string,
  typeMappingDefinitions: SavedObjectsTypeMappingDefinitions
): Index.FullIndexInfo {
  const targetMappings = disableUnknownTypeMappingFields(
    buildActiveMappings(typeMappingDefinitions),
    source.mappings
  );

  return {
    aliases: {},
    exists: false,
    indexName: nextIndexName(source.indexName, alias),
    mappings: targetMappings,
  };
}

function nextIndexName(indexName: string, alias: string) {
  const indexSuffix = (indexName.match(/[\d]+$/) || [])[0];
  const indexNum = parseInt(indexSuffix, 10) || 0;
  return `${alias}_${indexNum + 1}`;
}
