import * as  _ from 'lodash';
import { DownloadCompletionEventData } from './IContentDownload'
import { Inject } from 'typescript-ioc';
import * as path from 'path';
import DatabaseSDK from './../../sdk/database';
import { logger } from '@project-sunbird/ext-framework-server/logger';
import { containerAPI } from 'OpenRAP/dist/api';
import { manifest } from '../../manifest';
import { IDesktopAppMetadata, IAddedUsingType } from '../../controllers/content/IContent';
import * as  fs from 'fs';
let contentDb = "content_download";

export class ContentDownloadManager {

  contentManifest: any;
  fileSDK: any;
  contentFolder: string;
  ecarFolder: string;
  @Inject dbSDK: DatabaseSDK;
  manifestJson: any;

  constructor(public pluginId, downloadInfo: DownloadCompletionEventData) {
    this.dbSDK.initialize(pluginId);
    this.fileSDK = containerAPI.getFileSDKInstance(manifest.id);
    this.contentFolder = this.fileSDK.getAbsPath('content');
    this.ecarFolder = this.fileSDK.getAbsPath('ecars');
  }
  handleDownloadCompletion(){
    try {

    } catch {

    }
  }
  private async extractEcar() {
      if(this.contentImportData.importStep !== ImportSteps.extractEcar){
        this.contentImportData.importStep = ImportSteps.extractEcar;
        await this.syncStatusToDb();
      }
      const contentIds = [this.contentImportData.contentId];
      if (this.contentImportData.childNodes) {
        contentIds.push(...this.contentImportData.childNodes)
      }
      const dbContents = await this.getContentsFromDB(contentIds);
      this.workerProcessRef.send({
        message: this.contentImportData.importStep,
        contentImportData: this.contentImportData,
        dbContents
      });
  }

  async processContents() {
      if(this.contentImportData.importStep !== ImportSteps.processContents){
        this.contentImportData.importStep = ImportSteps.processContents;
        await this.syncStatusToDb();
      }
      const contentIds = [this.contentImportData.contentId];
      if (this.contentImportData.childNodes) {
        contentIds.push(...this.contentImportData.childNodes)
      }
      const dbContents = await this.getContentsFromDB(contentIds);
      await this.saveContentsToDb(dbContents)
      this.contentImportData.importStep = ImportSteps.complete;
      this.contentImportData.status = ImportStatus.completed;
  }

  private async saveContentsToDb(dbContents) {
    logger.info(this.contentImportData._id, 'saving contents to db');
    this.manifestJson = await this.fileSDK.readJSON(path.join(path.join(this.fileSDK.getAbsPath('content'), this.contentImportData.contentId), 'manifest.json'));
    let parent = _.get(this.manifestJson, 'archive.items[0]');
    parent._id = parent.identifier;
    const dbParent: any = _.find(dbContents, {identifier: parent.identifier});
    if(dbParent){
      parent._rev = dbParent._rev;
    }
    parent.baseDir = `content/${parent.identifier}`;
    parent.desktopAppMetadata = {
      "addedUsing": IAddedUsingType.import,
      "createdOn": Date.now(),
      "updatedOn": Date.now(),
    }
    let resources = [];
    if (this.contentImportData.contentType === 'application/vnd.ekstep.content-collection') {
      let itemsClone = _.cloneDeep(_.get(this.manifestJson, 'archive.items'));
      parent.children = this.createHierarchy(itemsClone, parent);
      resources = _.filter(_.get(this.manifestJson, 'archive.items'), item => (item.mimeType !== 'application/vnd.ekstep.content-collection'))
        .map(resource => {
          resource._id = resource.identifier;
          resource.baseDir = `content/${resource.identifier}`;
          resource.desktopAppMetadata = {
            "addedUsing": IAddedUsingType.import,
            "createdOn": Date.now(),
            "updatedOn": Date.now(),
          }
          resource.appIcon = resource.appIcon ? `content/${resource.appIcon}` : resource.appIcon;
          const dbResource: any = _.find(dbContents, {identifier: parent.identifier});
          if(dbResource){
            resource._rev = dbResource._rev;
            resource.visibility = dbResource.visibility;
          }
          return resource;
        });
    }
    await this.dbSDK.bulk('content', [parent, ...resources]);
  }

  cleanUpFolders(){
    // delete ecar folder and extracted content folders
  }

  private async getContentsFromDB(contentIds: Array<any>) {
    const dbResults = await this.dbSDK.find('content', {
      "selector": {
        identifier: {
          "$in": contentIds
        }
      }
    }).catch(err => undefined);
    return _.get(dbResults, 'docs') ? dbResults.docs : []
  }

  private createHierarchy(items: any[], parent: any, tree?: any[]): any {
    tree = typeof tree !== 'undefined' ? tree : [];
    parent = typeof parent !== 'undefined' ? parent : { visibility: 'Default' };
    if (parent.children && parent.children.length) {
      let children = [];
      _.forEach(items, (child) => {
        let childWithIndex = _.find(parent.children, { 'identifier': child.identifier })
        if (!_.isEmpty(childWithIndex)) {
          child.index = childWithIndex['index'];
          children.push(child)
        }
      });
      if (!_.isEmpty(children)) {
        children = _.sortBy(children, 'index');
        if (parent.visibility === 'Default') {
          tree = children;
        } else {
          parent['children'] = children;
        }
        _.each(children, (child) => { this.createHierarchy(items, child) });
      }
    }
    return tree;
  }
}