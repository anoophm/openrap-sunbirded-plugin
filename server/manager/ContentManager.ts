import { Inject } from 'typescript-ioc';
import * as path from 'path';
import * as glob from 'glob';
import * as _ from 'lodash';
import DatabaseSDK from './../sdk/database';
import { logger } from '@project-sunbird/ext-framework-server/logger';
import * as fs from 'fs';
import * as uuid from 'uuid';
import * as fse from 'fs-extra';
import { containerAPI } from 'OpenRAP/dist/api';
import { manifest } from '../manifest';
import { isRegExp } from 'util';
import config from '../config';
import { IDesktopAppMetadata, IAddedUsingType } from '../controllers/content/IContent';
import { fork } from 'child_process';


export default class ContentManager {

    private pluginId: string;
    private contentFilesPath: string;
    private downloadsFolderPath: string;


    private fileSDK;

    @Inject dbSDK: DatabaseSDK;

    private watcher: any;

    initialize(pluginId, contentFilesPath, downloadsFolderPath) {
        this.pluginId = pluginId;
        this.downloadsFolderPath = downloadsFolderPath;
        this.contentFilesPath = contentFilesPath;
        this.dbSDK.initialize(pluginId);
        this.fileSDK = containerAPI.getFileSDKInstance(manifest.id);
    }

    startImport(req) {
        return new Promise((resolve, reject) => {
            const forked = fork(path.join(__dirname, './../childProcess', 'contentImport.js'));
            forked.send({ headers: req.headers, fileName: req.fileName, pluginId: this.pluginId, 
                contentFilesPath: this.contentFilesPath, downloadsFolderPath: this.downloadsFolderPath});
            forked.on('message', (error, data) => {
                if (error) {
                    logger.debug(`ReqId = "${req.headers['X-msgid']}": child process returned error`, error)
                    reject(error);
                } else {
                    logger.debug(`ReqId = "${req.headers['X-msgid']}": child process returned succuss`)
                    resolve(data);
                }
            });    
        })
    }

}