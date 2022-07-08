import {
  HttpServiceStart,
  SavedObject,
  SavedObjectsBaseOptions,
  SavedObjectsBulkCreateObject,
  SavedObjectsBulkGetObject,
  SavedObjectsBulkResponse,
  SavedObjectsBulkUpdateObject,
  SavedObjectsBulkUpdateOptions,
  SavedObjectsBulkUpdateResponse,
  SavedObjectsClientWrapperFactory,
  SavedObjectsCreateOptions,
  SavedObjectsDeleteOptions,
  SavedObjectsFindOptions,
  SavedObjectsFindResponse,
  SavedObjectsUpdateOptions,
  SavedObjectsUpdateResponse,
} from 'opensearch-dashboards/server';
import { OpenSearchDashboardsAuthState } from '../auth/types/authentication_type';
import { SavedObjectsErrorHelpers } from '../../../../src/core/server';
import _ from 'lodash';

export class SecuritySavedObjectsClientWrapper {
  public httpStart?: HttpServiceStart;

  constructor() {}

  public wrapperFactory: SavedObjectsClientWrapperFactory = (wrapperOptions) => {
    const state: OpenSearchDashboardsAuthState =
      (this.httpStart!.auth.get(wrapperOptions.request).state as OpenSearchDashboardsAuthState) ||
      {};
    // console.log(`State: ${JSON.stringify(state)}`);
    const authInfo = state.authInfo!;
    const username = `user/${authInfo?.user_name || 'annonymous'}`;
    const roles = authInfo?.roles?.map((value) => `role/${value}`) || [];
    const accessibleIdentities = [username, ...roles];

    const createWithPermissionCheck = async <T = unknown>(
      type: string,
      attributes: T,
      options?: SavedObjectsCreateOptions
    ) => {
      options!.can_access = { ro_identities: [], rw_identities: [] };
      options!.can_access!.rw_identities!.push(...accessibleIdentities);
      return await wrapperOptions.client.create(type, attributes, options);
    };

    const bulkGetWithPermissionCheck = async <T = unknown>(
      objects: SavedObjectsBulkGetObject[] = [],
      options: SavedObjectsBaseOptions = {}
    ): Promise<SavedObjectsBulkResponse<T>> => {
      options!.can_access = { ro_identities: [], rw_identities: [] };
      options!.can_access!.rw_identities!.push(...accessibleIdentities);
      const bulkGetResult = await wrapperOptions.client.bulkGet(objects, options);
      bulkGetResult.saved_objects = bulkGetResult.saved_objects.map( (value) => {
        if (_.intersection(accessibleIdentities, value.can_access?.rw_identities).length === 0
            && _.intersection(accessibleIdentities, value.can_access?.ro_identities).length === 0) {
          // return ({
          //    ,
          //   type,
          //   error: errorContent(SavedObjectsErrorHelpers.createGenericNotFoundError(type, id)),
          // } as any) as SavedObject<T>;
          return {
            id: value.id,
            type: value.type,
            error: {
              statusCode: 403,
              message: 'Forbidden',
            }
          } as SavedObject<T>;
        } else {
          return value as SavedObject<T>;
        }
      });
      return bulkGetResult as SavedObjectsBulkResponse<T>;
      // return await wrapperOptions.client.bulkGet(objects, options);
    };

    const findWithPermissionCheck = async <T = unknown>(
      options: SavedObjectsFindOptions
    ): Promise<SavedObjectsFindResponse<T>> => {
      const identities = accessibleIdentities.join(' ');
      // if (!options.filter) {
      //   options.filter = `can_access.rw_identities:${identities} or can_access.ro_identities:${identities}`;
      // } else if (typeof options.filter === 'string') {
      //   options.filter += ` and (can_access.rw_identities:${identities} or can_access.ro_identities:${identities})`
      // } else {
      //   console.log('options.filter is a KQueryNode...');
      //   // options. fileter is KQueryNode, not support in PoC for now
      // }
      options.identities = accessibleIdentities;
      return await wrapperOptions.client.find(options);
    };

    const getWithPermissionCheck = async <T = unknown>(
      type: string,
      id: string,
      options: SavedObjectsBaseOptions = {}
    ): Promise<SavedObject<T>> => {
      const object = await wrapperOptions.client.get<T>(type, id, options);
      // console.log('-----');
      // console.log(accessibleIdentities);
      // console.log(object.can_access?.ro_identities);
      // console.log(object.can_access?.rw_identities);
      // console.log(object);

      if (
        object.can_access?.ro_identities?.includes('*') ||
        object.can_access?.rw_identities?.includes('*') ||
        _.intersection(accessibleIdentities, object.can_access?.rw_identities).length > 0 ||
        _.intersection(accessibleIdentities, object.can_access?.ro_identities).length > 0
      ) {
        return object;
      }
      throw SavedObjectsErrorHelpers.decorateForbiddenError(
        new Error(`Get saved object ${id} is forbidden.`)
      );
    };

    const updateWithPermissionCheck = async <T = unknown>(
      type: string,
      id: string,
      attributes: Partial<T>,
      options: SavedObjectsUpdateOptions = {}
    ): Promise<SavedObjectsUpdateResponse<T>> => {
      const object = await wrapperOptions.client.get<T>(type, id, options);
      if (
        object.can_access?.rw_identities?.includes('*') ||
        _.intersection(accessibleIdentities, object.can_access?.rw_identities).length > 0
      ) {
        return await wrapperOptions.client.update(type, id, attributes, options);
      }
      throw SavedObjectsErrorHelpers.decorateNotAuthorizedError(
        new Error(`Update saved object ${id} is not authorized.`)
      );
    };

    const bulkCreateWithPermissionCheck = async <T = unknown>(
      objects: Array<SavedObjectsBulkCreateObject<T>>,
      options?: SavedObjectsCreateOptions
    ): Promise<SavedObjectsBulkResponse<T>> => {
      options!.can_access = { ro_identities: [], rw_identities: [] };
      options!.can_access!.rw_identities!.push(...accessibleIdentities);
      return await wrapperOptions.client.bulkCreate(objects, options);
    };

    const bulkUpdateWithPermissionCheck = async <T = unknown>(
      objects: Array<SavedObjectsBulkUpdateObject<T>>,
      options?: SavedObjectsBulkUpdateOptions
    ): Promise<SavedObjectsBulkUpdateResponse<T>> => {
      return await wrapperOptions.client.bulkUpdate(objects, options);
    };

    const deleteWithPermissionCheck = async (
      type: string,
      id: string,
      options: SavedObjectsDeleteOptions = {}
    ) => {
      const object = await wrapperOptions.client.get(type, id, options);
      if (
        object.can_access?.rw_identities?.includes('*') ||
        _.intersection(accessibleIdentities, object.can_access?.rw_identities).length > 0
      ) {
        return await wrapperOptions.client.delete(type, id, options);
      }
      throw SavedObjectsErrorHelpers.decorateForbiddenError(
        new Error(`Deleting ${type}/${id} is forbidden.`)
      );
    };

    // const checkConflictsWithPermissionCheck = async (
    //   objects: SavedObjectsCheckConflictsObject[] = [],
    //   options: SavedObjectsBaseOptions = {}
    // ): Promise<SavedObjectsCheckConflictsResponse> => {
    //   return await wrapperOptions.client.checkConflicts(objects, options);
    // }

    // const addToNamespaces = async (
    //   type: string,
    //   id: string,
    //   namespaces: string[],
    //   options: SavedObjectsAddToNamespacesOptions = {}
    // ): Promise<SavedObjectsAddToNamespacesResponse> => {
    //   // return await this._repository.addToNamespaces(type, id, namespaces, options);
    // }

    // console.log(wrapperOptions);
    return {
      ...wrapperOptions.client,
      // get: (type, id, options) => wrapperOptions.client.get(type, id, options),
      get: getWithPermissionCheck,
      update: updateWithPermissionCheck,
      bulkCreate: bulkCreateWithPermissionCheck,
      bulkGet: bulkGetWithPermissionCheck,
      bulkUpdate: bulkUpdateWithPermissionCheck,
      create: createWithPermissionCheck,
      delete: deleteWithPermissionCheck,
      errors: wrapperOptions.client.errors,
      checkConflicts: wrapperOptions.client.checkConflicts,
      addToNamespaces: wrapperOptions.client.addToNamespaces,
      find: findWithPermissionCheck,
      deleteFromNamespaces: wrapperOptions.client.deleteFromNamespaces,
    };
  };
}
